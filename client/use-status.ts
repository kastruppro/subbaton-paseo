import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { statusRpc } from "../shared/contracts.js";
export function useStatus(hostId: string) {
  const read = useRpc(statusRpc);
  return useQuery({
    queryKey: ["subbaton-status", hostId],
    queryFn: () => read({}),
    refetchInterval: 5000,
    retry: false,
  });
}
