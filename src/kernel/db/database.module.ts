import { Module } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';

@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
