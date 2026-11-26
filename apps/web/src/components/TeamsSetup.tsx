import {
  MAX_TEAMS,
  MIN_TEAMS,
  TEAM_COLORS,
  TEAM_SCORING_HINT,
  TEAM_SCORING_LABELS,
  type TeamScoring,
  type TeamsInput,
} from '@gauntlet/shared';
import type { CSSProperties } from 'react';
import '../styles/challenges-teams.css';
import { Seg, Toggle } from './ui';

export interface TeamsDraft {
  scoring: TeamScoring;
  teams: { name: string; color: string }[];
  myTeam: number;
}

/** A name that matches each palette colour, so a fresh team never says "Red" in blue. */
const NAME_FOR_COLOR: Record<string, string> = {
  '#ff6b6b': 'Red Rockets',
  '#ffb347': 'Amber Aces',
  '#5fe08a': 'Green Giants',
  '#4dd0e1': 'Cyan Comets',
  '#7a9cff': 'Blue Blazers',
  '#e07aff': 'Violet Vipers',
};

export function newTeamsDraft(): TeamsDraft {
  return {
    scoring: 'avg',
    teams: [0, 4].map((i) => ({
      name: NAME_FOR_COLOR[TEAM_COLORS[i]!.hex]!,
      color: TEAM_COLORS[i]!.hex,
    })),
    myTeam: 0,
  };
}

/** Why the teams can't be used yet, or null. */
export function teamsProblem(d: TeamsDraft): string | null {
  const names = d.teams.map((t) => t.name.trim().toLowerCase());
  if (names.some((n) => !n)) return 'Give every team a name.';
  if (new Set(names).size !== names.length) return 'Give each team its own name.';
  return null;
}

export function teamsRequest(d: TeamsDraft): TeamsInput {
  return {
    scoring: d.scoring,
    teams: d.teams.map((t) => ({ name: t.name.trim(), color: t.color })),
    myTeam: d.myTeam,
  };
}

/** "Play in teams" on the new-challenge screen: 2-6 named, coloured teams and how they score. */
export function TeamsSetup({
  value,
  onChange,
  lowerIsBetter,
}: {
  value: TeamsDraft | null;
  onChange: (v: TeamsDraft | null) => void;
  lowerIsBetter: boolean;
}) {
  const set = (patch: Partial<TeamsDraft>) => value && onChange({ ...value, ...patch });
  const setTeam = (i: number, patch: Partial<TeamsDraft['teams'][number]>) =>
    value && set({ teams: value.teams.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  function addTeam() {
    if (!value || value.teams.length >= MAX_TEAMS) return;
    const used = new Set(value.teams.map((t) => t.color));
    const color = TEAM_COLORS.find((c) => !used.has(c.hex))!.hex;
    const taken = new Set(value.teams.map((t) => t.name));
    const preferred = NAME_FOR_COLOR[color]!;
    const name = taken.has(preferred) ? `Team ${value.teams.length + 1}` : preferred;
    set({ teams: [...value.teams, { name, color }] });
  }
  function removeTeam(i: number) {
    if (!value || value.teams.length <= MIN_TEAMS) return;
    set({
      teams: value.teams.filter((_, j) => j !== i),
      myTeam: value.myTeam === i ? 0 : value.myTeam > i ? value.myTeam - 1 : value.myTeam,
    });
  }

  return (
    <>
      <div className="lbl">Teams</div>
      <div className="card stack" style={{ gap: 12 }}>
        <div className="row">
          <div className="grow">
            <div style={{ fontWeight: 700 }}>Play in teams</div>
            <small className="muted">
              {value
                ? 'Everyone picks a team when they join. Teams lock once the challenge starts.'
                : 'Split into 2 to 6 teams and compete as a group.'}
            </small>
          </div>
          <Toggle
            checked={!!value}
            onChange={(on) => onChange(on ? newTeamsDraft() : null)}
            label="Play in teams"
          />
        </div>
        {value && (
          <>
            <Seg
              label="Team score"
              value={lowerIsBetter ? 'avg' : value.scoring}
              onChange={(v) => set({ scoring: v })}
              options={(['avg', 'sum'] as const).map((k) => ({
                value: k,
                label: TEAM_SCORING_LABELS[k],
              }))}
            />
            <small className="muted" style={{ lineHeight: 1.45 }}>
              {lowerIsBetter
                ? 'Lower is better here, so a team’s score is the average of its members.'
                : TEAM_SCORING_HINT[value.scoring]}
            </small>
            {value.teams.map((t, i) => (
              <div
                key={i}
                className="team-row"
                style={{ '--tc': t.color } as CSSProperties}
                role="group"
                aria-label={`Team ${i + 1}`}
              >
                <div className="row" style={{ gap: 8 }}>
                  <label className="input grow">
                    <input
                      value={t.name}
                      maxLength={24}
                      onChange={(e) => setTeam(i, { name: e.target.value })}
                      aria-label={`Team ${i + 1} name`}
                    />
                    <span>Team {i + 1}</span>
                  </label>
                  {value.teams.length > MIN_TEAMS && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      style={{ width: 'auto' }}
                      onClick={() => removeTeam(i)}
                      aria-label={`Remove team ${i + 1}`}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <div className="swatches" role="group" aria-label={`Team ${i + 1} colour`}>
                  {TEAM_COLORS.map((c) => {
                    const takenBy = value.teams.findIndex((x) => x.color === c.hex);
                    return (
                      <button
                        key={c.hex}
                        type="button"
                        className="swatch"
                        style={{ '--sw': c.hex } as CSSProperties}
                        aria-pressed={t.color === c.hex}
                        aria-label={`${c.label} for team ${i + 1}`}
                        disabled={takenBy !== -1 && takenBy !== i}
                        onClick={() => setTeam(i, { color: c.hex })}
                      />
                    );
                  })}
                </div>
                <button
                  type="button"
                  className={`btn sm ${value.myTeam === i ? '' : 'secondary'}`}
                  aria-pressed={value.myTeam === i}
                  onClick={() => set({ myTeam: i })}
                >
                  {value.myTeam === i ? 'You are on this team' : 'I’m on this team'}
                </button>
              </div>
            ))}
            {value.teams.length < MAX_TEAMS && (
              <button type="button" className="btn secondary sm" onClick={addTeam}>
                Add a team
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
