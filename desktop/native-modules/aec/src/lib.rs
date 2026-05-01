//! Lynn V0.79 AEC spike — tonarino webrtc-audio-processing v2.0.4 N-API binding
//!
//! 暴露给 Node.js 的最小 API:
//!   const aec = require('./lynn-aec-napi.node');
//!   const proc = aec.createProcessor({ sampleRate: 16000 });
//!   aec.processRender(proc, ttsPcmFloat32);   // 喂 TTS PCM 作 reference
//!   const cleaned = aec.processCapture(proc, micPcmFloat32);
//!   aec.destroy(proc);
//!
//! 帧大小:严格 10ms(16kHz = 160 samples,48kHz = 480 samples)
//! 顺序:render(far-end) 先 analyze,capture(near-end) 后 process

use napi::bindgen_prelude::Float32Array;
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::sync::{Arc, Mutex};
use webrtc_audio_processing::Processor;
use webrtc_audio_processing_config::{Config, EchoCanceller, NoiseSuppression, NoiseSuppressionLevel};

#[napi]
pub struct AecHandle {
    inner: Arc<Mutex<Processor>>,
    sample_rate: u32,
    samples_per_frame: usize,
}

#[napi(object)]
pub struct AecConfig {
    pub sample_rate: u32,
    pub enable_ns: Option<bool>,
}

#[napi]
pub fn create_processor(cfg: AecConfig) -> Result<AecHandle> {
    let processor = Processor::new(cfg.sample_rate)
        .map_err(|e| Error::new(Status::GenericFailure, format!("processor init: {:?}", e)))?;

    let mut config = Config::default();
    config.echo_canceller = Some(EchoCanceller::Full { stream_delay_ms: None });
    if cfg.enable_ns.unwrap_or(true) {
        config.noise_suppression = Some(NoiseSuppression {
            level: NoiseSuppressionLevel::Moderate,
            analyze_linear_aec_output: false,
        });
    }
    processor.set_config(config);

    let samples_per_frame = (cfg.sample_rate as usize) / 100; // 10ms
    Ok(AecHandle {
        inner: Arc::new(Mutex::new(processor)),
        sample_rate: cfg.sample_rate,
        samples_per_frame,
    })
}

/// 喂 far-end (TTS reference signal),帧必须 10ms
#[napi]
pub fn process_render(handle: &AecHandle, far_end_pcm: Float32Array) -> Result<()> {
    let len = far_end_pcm.len();
    if len != handle.samples_per_frame {
        return Err(Error::new(
            Status::InvalidArg,
            format!("far_end length {} != samples_per_frame {}", len, handle.samples_per_frame),
        ));
    }
    // tonarino 接受 IntoIterator<Item=Ch> where Ch: AsMut<[f32]>
    // 单声道 = 一个 channel,channel 是 Vec<f32>
    let frame: Vec<Vec<f32>> = vec![far_end_pcm.to_vec()];
    let proc = handle.inner.lock().unwrap();
    proc.process_render_frame(frame)
        .map_err(|e| Error::new(Status::GenericFailure, format!("render: {:?}", e)))?;
    Ok(())
}

/// 喂 near-end (mic),返回清掉 echo 的 mic
#[napi]
pub fn process_capture(handle: &AecHandle, near_end_pcm: Float32Array) -> Result<Float32Array> {
    let len = near_end_pcm.len();
    if len != handle.samples_per_frame {
        return Err(Error::new(
            Status::InvalidArg,
            format!("near_end length {} != samples_per_frame {}", len, handle.samples_per_frame),
        ));
    }
    let frame_data = near_end_pcm.to_vec();
    let mut frame: Vec<Vec<f32>> = vec![frame_data];
    let proc = handle.inner.lock().unwrap();
    proc.process_capture_frame(&mut frame)
        .map_err(|e| Error::new(Status::GenericFailure, format!("capture: {:?}", e)))?;
    // tonarino 把处理后的数据写回到 frame[0]
    let cleaned = std::mem::take(&mut frame[0]);
    Ok(Float32Array::new(cleaned))
}

#[napi]
pub fn info(handle: &AecHandle) -> String {
    format!(
        "AEC v2.0.4: sample_rate={}Hz samples/frame={} (10ms)",
        handle.sample_rate, handle.samples_per_frame
    )
}
