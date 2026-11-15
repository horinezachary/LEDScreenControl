// Email alerts. New alerts at or above the chosen severity are collected for a few seconds (several processors often
// fail together) and sent as one email; when an alert that was emailed clears, a recovery email follows. The same
// alert is not emailed again within the repeat window, so a flapping fault does not flood the inbox.
import nodemailer from 'nodemailer';
import type { Alert, EmailSettings } from '@ledmon/shared';
import { SEVERITY_ORDER } from '@ledmon/shared';

export interface AlertChange {
  processorId: string;
  processorName: string;
  alert: Alert;
  change: 'raised' | 'cleared';
}

export type SendMail = (msg: { from: string; to: string[]; subject: string; text: string }) => Promise<void>;

export function smtpSender(s: EmailSettings): SendMail {
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  return async (msg) => {
    await transport.sendMail({ from: msg.from, to: msg.to.join(', '), subject: msg.subject, text: msg.text });
  };
}

export class Alerter {
  private pending: AlertChange[] = [];
  private timer?: NodeJS.Timeout;
  /** Alert key -> when it was last emailed. */
  private lastSent = new Map<string, number>();
  /** Alerts emailed as raised and not yet cleared, so only those get a recovery email. */
  private open = new Set<string>();

  constructor(
    private settings: EmailSettings,
    private send: SendMail = smtpSender(settings),
    private log: (level: 'info' | 'warning', message: string) => void = () => {},
    private batchMs = 5000,
  ) {}

  update(settings: EmailSettings, send: SendMail = smtpSender(settings)): void {
    this.settings = settings;
    this.send = send;
  }

  handle(c: AlertChange, now = Date.now()): void {
    const s = this.settings;
    if (!s.enabled || !s.to.length) return;
    const id = `${c.processorId}|${c.alert.key}`;
    if (c.change === 'raised') {
      if (SEVERITY_ORDER.indexOf(c.alert.severity) > SEVERITY_ORDER.indexOf(s.minSeverity)) return;
      const last = this.lastSent.get(id);
      if (last !== undefined && now - last < s.repeatMinutes * 60_000) return;
      this.lastSent.set(id, now);
      this.open.add(id);
    } else {
      if (!this.open.has(id)) return;
      this.open.delete(id);
    }
    this.pending.push(c);
    this.timer ??= setTimeout(() => void this.flush(), this.batchMs);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending.splice(0);
    if (!batch.length) return;
    const msg = compose(batch);
    try {
      await this.send({ from: this.settings.from, to: this.settings.to, ...msg });
      this.log('info', `Alert email sent to ${this.settings.to.join(', ')}: ${msg.subject}`);
    } catch (err) {
      this.log('warning', `Alert email could not be sent: ${(err as Error).message}`);
    }
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

export function compose(batch: AlertChange[]): { subject: string; text: string } {
  const raised = batch.filter((c) => c.change === 'raised');
  const cleared = batch.filter((c) => c.change === 'cleared');
  const worst = raised.some((c) => c.alert.severity === 'critical') ? 'Critical' : raised.length ? 'Warning' : 'Recovered';
  const first = (raised[0] ?? cleared[0])!;
  const more = batch.length > 1 ? ` (+${batch.length - 1} more)` : '';
  const subject = `[LED Monitor] ${worst}: ${first.processorName}: ${first.alert.message}${more}`;
  const line = (c: AlertChange) => `- ${c.processorName}: ${c.alert.message}${c.change === 'raised' ? ` (${c.alert.severity})` : ''}`;
  const parts: string[] = [];
  if (raised.length) parts.push('New problems:', ...raised.map(line), '');
  if (cleared.length) parts.push('Cleared:', ...cleared.map(line), '');
  parts.push(`Sent by LED Monitor at ${new Date().toLocaleString()}.`);
  return { subject, text: parts.join('\n') };
}
