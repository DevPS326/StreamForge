"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { UploadManager } from "@/lib/uploads";

const UploadContext = createContext<UploadManager | null>(null);

export function UploadProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const [manager] = useState(() => new UploadManager(userId));
  useEffect(() => manager.connect(), [manager]);
  return (
    <UploadContext.Provider value={manager}>{children}</UploadContext.Provider>
  );
}

export function useUploadManager() {
  const manager = useContext(UploadContext);
  if (!manager) throw new Error("Upload provider missing");
  return manager;
}

export function useUploads() {
  const manager = useUploadManager();
  return useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getServerSnapshot,
  );
}
