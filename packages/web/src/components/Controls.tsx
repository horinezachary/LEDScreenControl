import { useEffect, useState } from 'react';
import type { ControlRequest, ProcessorView } from '@ledmon/shared';
import { CONFIRM_ACTIONS } from '@ledmon/shared';
import { api } from '../api';

// Processor controls. Anyone on the network may use them (as designed). Blackout, failover, input changes and
// reboot ask a second time, naming the processor, before anything is sent. Every action lands in the event log.

type Pending = { req: ControlRequest; question: string; confirm: string };

export function Controls({ p }: { p: ProcessorView }) {
  const caps = p.controls;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [pending, setPending] = useState<Pending>();
  const [brightness, setBrightness] = useState<number>(p.brightness ?? 0);
  const [preset, setPreset] = useState<number | undefined>(p.preset?.number);
  const [input, setInput] = useState<string | undefined>(p.inputs.find((i) => i.active)?.key);

  // Follow changes made elsewhere (another browser, the processor's own panel) unless this one is mid-edit.
  useEffect(() => {
    if (!busy && p.brightness !== undefined) setBrightness(p.brightness);
  }, [p.brightness]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!caps) {
    return <p className="sub">Controls are turned off in the settings, or this processor has none on the dashboard.</p>;
  }

  const send = async (req: ControlRequest) => {
    setPending(undefined);
    setBusy(true);
    setMessage(undefined);
    try {
      await api('POST', `/api/processors/${encodeURIComponent(p.id)}/control`, req);
      setMessage({ ok: true, text: req.action === 'resetErrors' ? 'Done. Only receiving card errors counted from now on are flagged.' : 'Done. The processor confirmed it.' });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const ask = (req: ControlRequest, question: string, confirm: string) => {
    if (CONFIRM_ACTIONS.includes(req.action)) setPending({ req, question, confirm });
    else void send(req);
  };

  const disabled = busy || !p.reachable;
  const activeInput = p.inputs.find((i) => i.active);

  return (
    <div className="controls">
      {!p.reachable && <p className="note bad">{p.name} is not answering, so controls are paused.</p>}

      {caps.brightness && (
        <div className="control-row">
          <label htmlFor={`b-${p.id}`}>Brightness</label>
          <input
            id={`b-${p.id}`}
            type="range"
            min={caps.brightness.min}
            max={caps.brightness.max}
            step={caps.brightness.step}
            value={brightness}
            onChange={(e) => setBrightness(Number(e.target.value))}
            disabled={disabled}
          />
          <input
            className="num"
            type="number"
            min={caps.brightness.min}
            max={caps.brightness.max}
            step={caps.brightness.step}
            value={brightness}
            onChange={(e) => setBrightness(Number(e.target.value))}
            disabled={disabled}
            aria-label={`Brightness in ${caps.brightness.unit}`}
          />
          <span className="unit">{caps.brightness.unit}</span>
          <button type="button" className="btn" disabled={disabled || brightness === p.brightness} onClick={() => void send({ action: 'brightness', value: brightness })}>
            Set
          </button>
        </div>
      )}

      {(caps.blackout || caps.freeze) && (
        <div className="control-row">
          <span className="label">Output</span>
          {caps.blackout && (
            <button
              type="button"
              className={`btn ${p.blackout ? 'danger' : ''}`}
              aria-pressed={!!p.blackout}
              disabled={disabled}
              onClick={() =>
                p.blackout
                  ? ask({ action: 'blackout', value: false }, `Turn blackout off on ${p.name}? The wall shows the picture again.`, `Show picture on ${p.name}`)
                  : ask({ action: 'blackout', value: true }, `Black out ${p.name}? The wall goes dark until blackout is turned off.`, `Black out ${p.name}`)
              }
            >
              {p.blackout ? 'Blackout is on · turn off' : 'Blackout'}
            </button>
          )}
          {caps.freeze && (
            <button type="button" className={`btn ${p.freeze ? 'danger' : ''}`} aria-pressed={!!p.freeze} disabled={disabled} onClick={() => void send({ action: 'freeze', value: !p.freeze })}>
              {p.freeze ? 'Frozen · unfreeze' : 'Freeze'}
            </button>
          )}
        </div>
      )}

      {caps.preset && (p.presets?.length ?? 0) > 0 && (
        <div className="control-row">
          <label htmlFor={`p-${p.id}`}>Preset</label>
          <select id={`p-${p.id}`} value={preset ?? ''} onChange={(e) => setPreset(Number(e.target.value))} disabled={disabled}>
            {p.presets!.map((x) => (
              <option key={x.number} value={x.number}>
                {x.number} · {x.name}
                {x.number === p.preset?.number ? ' (active)' : ''}
              </option>
            ))}
          </select>
          <button type="button" className="btn" disabled={disabled || preset === undefined || preset === p.preset?.number} onClick={() => preset !== undefined && void send({ action: 'preset', value: preset })}>
            Load
          </button>
        </div>
      )}

      {caps.input && p.inputs.some((i) => i.key) && (
        <div className="control-row">
          <label htmlFor={`i-${p.id}`}>Input</label>
          <select id={`i-${p.id}`} value={input ?? ''} onChange={(e) => setInput(e.target.value)} disabled={disabled}>
            {p.inputs
              .filter((i) => i.key)
              .map((i) => (
                <option key={i.key} value={i.key}>
                  {i.label}
                  {i.active ? ' (active)' : ''}
                  {i.signal ? '' : ' · no signal'}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={disabled || !input || input === activeInput?.key}
            onClick={() => {
              const target = p.inputs.find((i) => i.key === input);
              if (target) ask({ action: 'input', value: target.key! }, `Switch ${p.name} from ${activeInput?.label ?? 'its input'} to ${target.label}${target.signal ? '' : ', which has no signal'}?`, `Switch ${p.name} to ${target.label}`);
            }}
          >
            Switch
          </button>
        </div>
      )}

      {(caps.failover || caps.reboot) && (
        <div className="control-row">
          <span className="label">Processor</span>
          {caps.failover && (
            <button
              type="button"
              className="btn"
              disabled={disabled}
              onClick={() =>
                ask({ action: 'failover' }, `Request failover on ${p.name}? Its redundant partner${p.failover?.partnerName ? `, ${p.failover.partnerName},` : ''} takes over or hands back the wall.`, `Request failover on ${p.name}`)
              }
            >
              Request failover
            </button>
          )}
          {caps.reboot && (
            <button type="button" className="btn danger" disabled={disabled} onClick={() => ask({ action: 'reboot' }, `Reboot ${p.name}? It stops driving the wall until it has started again.`, `Reboot ${p.name}`)}>
              Reboot
            </button>
          )}
        </div>
      )}

      {caps.resetErrors && (
        <div className="control-row">
          <span className="label">Card errors</span>
          <button type="button" className="btn" disabled={disabled} onClick={() => void send({ action: 'resetErrors' })}>
            Reset error counts
          </button>
          <span className="sub">
            {p.tiles?.errors ? `${p.tiles.errors} cabinet${p.tiles.errors === 1 ? '' : 's'} flagged. ` : ''}Only the dashboard forgets; the processor keeps its own counts.
          </span>
        </div>
      )}

      {pending && (
        <div className="confirm" role="alertdialog" aria-label="Confirm">
          <p>{pending.question}</p>
          <div className="confirm-buttons">
            <button type="button" className="btn danger" onClick={() => void send(pending.req)} autoFocus>
              {pending.confirm}
            </button>
            <button type="button" className="btn" onClick={() => setPending(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {busy && <p className="sub">Sending…</p>}
      {message && <p className={`note ${message.ok ? 'good' : 'bad'}`}>{message.text}</p>}
      <p className="sub">Every control action is written to the event log with the address it came from.</p>
    </div>
  );
}
