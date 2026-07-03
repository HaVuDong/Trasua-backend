function parseOriginList(value?: string) {
  return String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getCorsOrigin() {
  const configured = parseOriginList(process.env.ALLOWED_ORIGINS);
  if (process.env.NODE_ENV === 'production') {
    if (configured.length === 0 || configured.includes('*')) {
      console.warn('ALLOWED_ORIGINS is not set or includes *. Falling back to accepting all origins for now.');
      return true;
    }
    return configured;
  }
  return configured.length > 0 ? configured : true;
}

async function bootstrap() {
  const shouldUseRedisMock =
    process.env.USE_REDIS_MOCK === 'true' &&
    process.env.NODE_ENV !== 'production';
  if (shouldUseRedisMock) {
    await import('./mock-redis.js');
  } else if (process.env.USE_REDIS_MOCK === 'true') {
    console.warn(
      'USE_REDIS_MOCK is ignored in production. Configure a real Redis service instead.',
    );
  }

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module.js');
  const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
  const { default: helmet } = await import('helmet');

  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  app.enableCors({
    origin: getCorsOrigin(),
    credentials: true,
  });

  // Swagger Documentation Setup
  const config = new DocumentBuilder()
    .setTitle('TraSua SaaS API')
    .setDescription(
      'The multi-tenant SaaS F&B restaurant/cafe backend API specification.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(
    `Swagger documentation is available at: http://localhost:${port}/api/docs`,
  );
}
bootstrap();
