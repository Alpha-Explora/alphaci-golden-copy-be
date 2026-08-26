const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module.js');
const {
  OutboxRelayService,
} = require('../dist/src/modules/platform-ops/application/outbox-relay.service.js');

async function main() {
  const limit = Number(process.env.OUTBOX_BATCH_SIZE || 50);
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

main().catch((error) => {
  console.error(`Outbox processing failed: ${String(error)}`);
  process.exitCode = 1;
});
