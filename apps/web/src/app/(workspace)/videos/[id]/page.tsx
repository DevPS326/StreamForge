import { VideoDetail } from "@/components/video-detail";

export const metadata = { title: "Video details" };

export default async function VideoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <VideoDetail key={id} id={id} />;
}
