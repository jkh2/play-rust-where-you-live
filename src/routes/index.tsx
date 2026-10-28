import { createFileRoute } from "@tanstack/react-router";
import { Maker } from "@/components/maker/Maker";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <Maker />;
}

