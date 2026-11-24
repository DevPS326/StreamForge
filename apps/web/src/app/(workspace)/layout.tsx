import { Workspace } from "@/components/workspace";
import type { ReactNode } from "react";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <Workspace>{children}</Workspace>;
}
