import fp from '../FloatingPanels.module.css';

const DAY_KEYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const DAY_KEYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function DaySelector({
  selected,
  single = false,
  onChange,
  isZh,
}: {
  selected: number[];
  single?: boolean;
  onChange: (days: number[]) => void;
  isZh: boolean;
}) {
  const labels = isZh ? DAY_KEYS_ZH : DAY_KEYS_EN;
  return (
    <div className={fp.automationDaySelector}>
      {labels.map((label, index) => {
        const active = selected.includes(index);
        return (
          <button
            key={`${label}-${index}`}
            type="button"
            className={`${fp.automationDayBtn}${active ? ` ${fp.automationDayBtnActive}` : ''}`}
            onClick={() => {
              if (single) {
                onChange([index]);
                return;
              }
              if (active) {
                onChange(selected.filter((day) => day !== index));
              } else {
                onChange([...selected, index]);
              }
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function TimePicker({
  hour,
  minute,
  onChange,
}: {
  hour: string;
  minute: string;
  onChange: (hour: string, minute: string) => void;
}) {
  return (
    <span className={fp.automationTimePicker}>
      <input
        type="number"
        className={fp.automationTimeInput}
        min={0}
        max={23}
        value={hour}
        onChange={(event) => {
          let next = parseInt(event.target.value, 10);
          if (Number.isNaN(next)) next = 0;
          next = Math.max(0, Math.min(23, next));
          onChange(String(next).padStart(2, '0'), minute);
        }}
      />
      <span className={fp.automationTimeColon}>:</span>
      <input
        type="number"
        className={fp.automationTimeInput}
        min={0}
        max={59}
        value={minute}
        onChange={(event) => {
          let next = parseInt(event.target.value, 10);
          if (Number.isNaN(next)) next = 0;
          next = Math.max(0, Math.min(59, next));
          onChange(hour, String(next).padStart(2, '0'));
        }}
      />
    </span>
  );
}
