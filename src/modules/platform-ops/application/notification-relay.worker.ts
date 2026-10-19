import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DatabaseService } from '#kernel/db/database.service';
import { OutboxRelayService } from './outbox-relay.service';

/** A fast notification-only pass; the GitHub sync worker keeps its own cadence. */
@Injectable()
export class NotificationRelayWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationRelayWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly relay: OutboxRelayService,
  ) {}

  onModuleInit(): void {
    if (
      !this.database.isEnabled() ||
      process.env['OUTBOX_RELAY_INTERVAL_MS'] === '0'
    )
      return;
    const raw = Number(process.env['NOTIFICATION_RELAY_INTERVAL_MS'] ?? 1000);
    if (raw === 0) return;
    const interval = Number.isFinite(raw)
      ? Math.max(250, Math.min(60000, raw))
      : 1000;
    this.timer = setInterval(() => {
      void this.deliver();
    }, interval);
    this.timer.unref();
  }

  async deliver(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.relay.processNotificationEventsOnce();
    } catch (error) {
      this.logger.error(
        `Notification delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
