import {
  Injectable,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
  type MessageEvent,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  defer,
  distinctUntilChanged,
  exhaustMap,
  finalize,
  map,
  shareReplay,
  timer,
  Subject,
  takeUntil,
  type Observable,
} from 'rxjs';
import { NotificationsService } from './notifications.service';

interface Reader {
  stream: Observable<MessageEvent>;
  subscribers: number;
}

/** Shared DB reads per recipient, independent of which instance delivered the outbox event. */
@Injectable()
export class NotificationStreamService implements OnModuleDestroy {
  private readonly readers = new Map<string, Reader>();
  private readonly shutdown = new Subject<void>();
  readonly closed$ = this.shutdown.asObservable();
  constructor(private readonly notifications: NotificationsService) {}

  open(userId: string): Observable<MessageEvent> {
    return defer(() => {
      let reader = this.readers.get(userId);
      if (!reader) {
        if (this.readers.size >= 1000)
          throw new ServiceUnavailableException(
            'Notification streams are busy',
          );
        reader = {
          subscribers: 0,
          stream: timer(0, 1000).pipe(
            exhaustMap(() => this.notifications.listForUser(userId)),
            distinctUntilChanged(
              (previous, next) =>
                JSON.stringify(previous) === JSON.stringify(next),
            ),
            map((notifications) => ({
              data: { kind: 'snapshot', userId, notifications },
            })),
            shareReplay({ bufferSize: 1, refCount: true }),
          ),
        };
        this.readers.set(userId, reader);
      }
      if (reader.subscribers >= 5)
        throw new HttpException(
          'Too many notification streams',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      reader.subscribers += 1;
      const active = reader;
      return reader.stream.pipe(
        takeUntil(this.closed$),
        finalize(() => {
          active.subscribers -= 1;
          if (active.subscribers === 0) this.readers.delete(userId);
        }),
      );
    });
  }

  onModuleDestroy(): void {
    this.shutdown.next();
    this.shutdown.complete();
  }
}
