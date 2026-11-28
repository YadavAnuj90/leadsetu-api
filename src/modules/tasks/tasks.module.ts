import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TasksController } from './tasks.controller';
import { TaskDocument, TaskItem, TaskItemSchema, TasksService } from './tasks.service';
import { CreateTaskDto, UpdateTaskDto } from './dto/tasks.dto';

export {
  TaskItem,
  TaskItemSchema,
  TasksService,
  TasksController,
  CreateTaskDto,
  UpdateTaskDto,
};
export type { TaskDocument };

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: TaskItem.name, schema: TaskItemSchema }]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_SECRET') ||
          'leadsetu_super_secret_access_key_2026',
      }),
    }),
  ],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
