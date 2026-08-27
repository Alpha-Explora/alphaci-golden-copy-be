const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module.js');
const {
  OutboxRelayService,
} = require('../dist/src/modules/platform-ops/application/outbox-relay.service.js');

async function main() {
  const limit = positiveInteger(process.env.OUTBOX_BATCH_SIZE, 50, 500);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const relay = app.get(OutboxRelayService);
    const processed = await relay.processPendingOnce(limit);
    console.log(`Processed ${processed} outbox event(s).`);
  } finally {
    await app.close();
  }
}

function positiveInteger(raw, fallback, maximum) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback;
}

main().catch((error) => {
  console.error(`Outbox processing failed: ${String(error)}`);
  process.exitCode = 1;
});
