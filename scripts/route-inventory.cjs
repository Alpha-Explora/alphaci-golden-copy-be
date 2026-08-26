const { NestFactory } = require('@nestjs/core');
const { DocumentBuilder, SwaggerModule } = require('@nestjs/swagger');
const { AppModule } = require('../dist/src/app.module.js');

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    app.setGlobalPrefix('api/v1');
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('AlphaCI route inventory').build(),
    );
    const routes = Object.entries(document.paths)
      .flatMap(([path, operations]) =>
        Object.keys(operations)
          .filter((method) => method !== 'parameters')
          .map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    console.log(routes.join('\n'));
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(`Route inventory failed: ${String(error)}`);
  process.exitCode = 1;
});
