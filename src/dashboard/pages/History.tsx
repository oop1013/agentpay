import React from "react";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";

interface UsageRecord {
  id: string;
  serviceId: string;
  callerWallet: string;
  providerWallet: string;
  grossAmount: number;
  platformFee: number;
  providerNet: number;
  status: string;
  latencyMs: number;
  timestamp: string;
}

export default function History() {
  const { address, isConnected } = useAccount();

  const { data, isLoading } = useQuery({
    queryKey: ["usage", address],
    queryFn: async () => {
      const res = await fetch(`/api/wallets/${address}/usage?limit=100`);
      return res.json() as Promise<{ records: UsageRecord[] }>;
    },
    enabled: isConnected,
  });

  if (!isConnected) {
    return <p className="text-gray-500 text-sm">Connect wallet to view usage history.</p>;
  }

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Usage History</h2>

      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : !data?.records?.length ? (
        <div className="text-gray-500 text-sm bg-white border rounded p-6 text-center">
          <p className="font-medium mb-1">No usage history yet.</p>
          <p>Records appear here after you make paid API calls via an AgentPay-protected service.</p>
        </div>
      ) : (
        <table className="w-full bg-white border rounded text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-4 py-2">Timestamp</th>
              <th className="px-4 py-2">Service</th>
              <th className="px-4 py-2">Amount</th>
              <th className="px-4 py-2">Fee</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Latency</th>
            </tr>
          </thead>
          <tbody>
            {data.records.map((rec) => (
              <tr key={rec.id} className="border-b hover:bg-gray-50">
                <td className="px-4 py-2 text-xs text-gray-600">
                  {new Date(rec.timestamp).toLocaleString()}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{rec.serviceId}</td>
                <td className="px-4 py-2">{formatMicroUsdc(rec.grossAmount)}</td>
                <td className="px-4 py-2 text-gray-500">{formatMicroUsdc(rec.platformFee)}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={rec.status} />
                </td>
                <td className="px-4 py-2 text-gray-500">{rec.latencyMs}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    success: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
    timeout: "bg-yellow-100 text-yellow-700",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${colors[status] ?? "bg-gray-100 text-gray-700"}`}>
      {status}
    </span>
  );
}

function formatMicroUsdc(micro: number | string): string {
  const val = Number(micro);
  if (val === 0) return "0 USDC";
  return `${(val / 1_000_000).toFixed(6)} USDC`;
}
