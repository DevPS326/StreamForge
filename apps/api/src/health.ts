import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Database } from "./database";
import { Storage } from "./storage";

@ApiTags("Health")
@Controller("health")
export class HealthController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Storage) private readonly storage: Storage,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    try {
      await Promise.all([this.db.$queryRaw`SELECT 1`, this.storage.ready()]);
      return { status: "ready" };
    } catch {
      throw new ServiceUnavailableException("Dependencies are unavailable");
    }
  }
}
