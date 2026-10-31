import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { createSettingsOnboardingController } = createRequire(import.meta.url)('../desktop/settings-onboarding-controller.cjs');
function setup() {
  class Window extends EventEmitter {
    constructor() {
      super();this.webContents=Object.assign(new EventEmitter(),{
        send:vi.fn(),isCrashed:()=>false,getURL:()=> 'file:///settings.html',
        executeJavaScript:async()=>({rootChildren:1,bodyText:'Settings'}),
        session:{clearCache:async()=>{},clearStorageData:async()=>{}},
      });
    }
    isDestroyed(){return false;}show(){}focus(){}
  }
  const controller=createSettingsOnboardingController({BrowserWindow:Window,fs:{},lynnHome:'/fixture',loadWindowURL:async()=>{},getWindowEntryStamp:()=> 'same',titleBarOpts:()=>({}),themeBg:{'warm-paper':'#fff'},getBrowserTheme:()=> 'warm-paper',markPreferredPrimaryWindow:()=>{}});
  controller.createSettingsWindow({tab:'providers',providerId:'deepseek'});
  const win=controller.getSettingsWindow();win.webContents.emit('did-finish-load');
  return {controller,win,event:{sender:win.webContents}};
}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
it('does not replay a consumed deep link after the user changes provider', async()=>{
  const {controller,win,event}=setup();expect(controller.getInitialSettingsNavigationTarget(event)).toEqual({tab:'providers',providerId:'deepseek'});
  await vi.advanceTimersByTimeAsync(2000);expect(win.webContents.send).not.toHaveBeenCalled();
});
it('stops fallback delivery as soon as boot consumes the target', async()=>{
  const {controller,win,event}=setup();await vi.advanceTimersByTimeAsync(300);expect(win.webContents.send).toHaveBeenCalledTimes(1);
  controller.getInitialSettingsNavigationTarget(event);await vi.advanceTimersByTimeAsync(1500);expect(win.webContents.send).toHaveBeenCalledTimes(1);
});
it('still delivers a new explicit navigation request to an existing window', async()=>{
  const {controller,win,event}=setup();controller.getInitialSettingsNavigationTarget(event);
  controller.createSettingsWindow({tab:'providers',providerId:'local-qwen35-9b-q4km-imatrix'});
  expect(win.webContents.send).toHaveBeenCalledWith('settings-switch-tab',{tab:'providers',providerId:'local-qwen35-9b-q4km-imatrix'});
  await vi.advanceTimersByTimeAsync(2000);expect(win.webContents.send).toHaveBeenCalledTimes(1);
});
