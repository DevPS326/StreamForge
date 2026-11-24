import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { PrismaClient } from "@streamforge/db";

@Injectable()
export class Database extends PrismaClient implements OnApplicationShutdown {
  async onApplicationShutdown() {
    try {
      await this.$disconnect();
    } catch (error) {
      new Logger(Database.name).warn({
        event: "database_disconnect_failed",
        error: error instanceof Error ? error.name : "Unknown",
      });
    }
  }
}
