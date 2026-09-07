import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';

// Standalone datasource for the TypeORM CLI (migration:generate/run/revert)
// — runs outside Nest's DI, so it can't use ConfigService and loads `.env`
// directly instead. Not used by the running app itself; see
// TypeOrmModule.forRootAsync in app.module.ts for that.
config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME ?? 'fpl_bot',
  username: process.env.DATABASE_USER ?? 'fpl_bot',
  password: process.env.DATABASE_PASSWORD ?? 'fpl_bot',
  entities: [__dirname + '/entities/*.entity.{ts,js}'],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
});
