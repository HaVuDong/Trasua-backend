async function bootstrap() {
  const shouldUseRedisMock = process.env.USE_REDIS_MOCK === 'true' && process.env.NODE_ENV !== 'production';
  if (shouldUseRedisMock) {
    await import('./mock-redis.js');
  } else if (process.env.USE_REDIS_MOCK === 'true') {
    console.warn('USE_REDIS_MOCK is ignored in production. Configure a real Redis service instead.');
  }

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module.js');
  const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');

  const app = await NestFactory.create(AppModule);

  // Enable CORS
  app.enableCors();

  // Swagger Documentation Setup
  const config = new DocumentBuilder()
    .setTitle('TraSua SaaS API')
    .setDescription('The multi-tenant SaaS F&B restaurant/cafe backend API specification.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
    
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger documentation is available at: http://localhost:${port}/api/docs`);
}
bootstrap();
