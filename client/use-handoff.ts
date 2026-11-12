import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { handoffStatusRpc } from "../shared/handoff.js";
export function useHandoff(hostId: string) {
  const read = useRpc(handoffStatusRpc);
  return useQuery({
    queryKey: ["subbaton-handoff", hostId],
    queryFn: () => read({}),
    refetchInterval: 3000,
    retry: false,
  });
}
