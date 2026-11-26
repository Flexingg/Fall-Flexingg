import { fromDisplayUnit, toDisplayUnit, type WeightGoalParams } from '@gauntlet/shared';
import { useState } from 'react';
import { useDisplay } from '../lib/display';
import { Seg } from './ui';

/**
 * Each person's own weight target for a weight challenge. Only the % of it reached is ever shown
 * to anyone else.
 */
export function WeightGoalFields({
  value,
  onChange,
}: {
  value: WeightGoalParams | null;
  onChange: (v: WeightGoalParams | null) => void;
}) {
  const [direction, setDirection] = useState<WeightGoalParams['direction']>(
    value?.direction ?? 'lose',
  );
  const [targetType, setTargetType] = useState<WeightGoalParams['targetType']>(
    value?.targetType ?? 'percent',
  );
  const { units } = useDisplay();
  const kgLabel = toDisplayUnit(1, 'kg', 1, units).unit;
  // Typed in the person's own unit (lb for imperial); the target is kept in kilograms.
  const [target, setTarget] = useState(
    value
      ? String(
          value.targetType === 'kg'
            ? +toDisplayUnit(value.target, 'kg', 1, units).value.toFixed(1)
            : value.target,
        )
      : '',
  );

  function emit(next: Partial<{ direction: string; targetType: string; target: string }>) {
    const d = (next.direction ?? direction) as WeightGoalParams['direction'];
    const t = (next.targetType ?? targetType) as WeightGoalParams['targetType'];
    const typed = Number(next.target ?? target);
    const n = t === 'kg' ? Number(fromDisplayUnit(typed, 'kg', units).toFixed(2)) : typed;
    onChange(n > 0 ? { direction: d, targetType: t, target: n } : null);
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <Seg
        label="Lose or gain"
        value={direction}
        onChange={(v) => {
          setDirection(v);
          emit({ direction: v });
        }}
        options={[
          { value: 'lose', label: 'Lose weight' },
          { value: 'gain', label: 'Gain weight' },
        ]}
      />
      <div className="row" style={{ gap: 10 }}>
        <label className="input grow">
          <input
            inputMode="decimal"
            value={target}
            onChange={(e) => {
              const v = e.target.value.replace(/[^\d.]/g, '');
              setTarget(v);
              emit({ target: v });
            }}
            placeholder={targetType === 'percent' ? '5' : units === 'imperial' ? '9' : '4'}
            aria-label="My target"
          />
          <span>{targetType === 'percent' ? '% of my weight' : kgLabel}</span>
        </label>
        <Seg
          label="Target unit"
          value={targetType}
          onChange={(v) => {
            setTargetType(v);
            emit({ targetType: v });
          }}
          options={[
            { value: 'percent', label: '%' },
            { value: 'kg', label: kgLabel },
          ]}
        />
      </div>
      <small className="muted" style={{ lineHeight: 1.45 }}>
        You're scored on how much of your own target you reach, from your last weigh-in in
        SparkyFitness before the start. Nobody sees your weight.
      </small>
    </div>
  );
}
