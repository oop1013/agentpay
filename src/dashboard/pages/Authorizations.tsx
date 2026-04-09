import React from "react";
import { useAccount } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";

interface Authorization {
  callerWallet: string;
  serviceId: string;
  spendCap: number;
  spent: number;
  status: string;
  createdAt: string;
}

export default function Authorizations() {
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["authorizations", address],
    queryFn: async () => {
      const res = await fetch(`/api/auth/${address}`);
      return res.json() as Promise<{ authorizations: Authorization[] }>;
    },
    enabled: isConnected,
  });

  async function handleRevoke(serviceId: string) {
    if (!address) return;
    const res = await fetch(`/api/auth/${address}/${serviceId}`, { method: "DELETE" });
    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["authorizations", address] });
    }
  }

  if (!isConnected) {
    return <p className="text-gray-500 text-sm">Connect wallet to view authorizations.</p>;
  }

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Authorizations</h2>

      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : !data?.authorizations?.length ? (
        <div className="text-gray-500 text-sm bg-white border rounded p-6 text-center">
          <p className="font-medium mb-1">No authorizations yet.</p>
          <p>Go to <strong>Services</strong> and click <strong>Authorize</strong> on a service to set a spend cap.</p>
        </div>
      ) : (
        <table className="w-full bg-white border rounded text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-4 py-2">Service</th>
              <th className="px-4 py-2">Spend Cap</th>
              <th className="px-4 py-2">Spent</th>
              <th className="px-4 py-2">Remaining</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Created</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {data.authorizations.map((auth) => {
              const cap = Number(auth.spendCap);
              const spent = Number(auth.spent);
              const remaining = cap - spent;
              const pct = cap > 0 ? Math.min((spent / cap) * 100, 100) : 0;

              return (
                <tr key={auth.serviceId} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">{auth.serviceId}</td>
                  <td className="px-4 py-2">{formatMicroUsdc(cap)}</td>
                  <td className="px-4 py-2">{formatMicroUsdc(spent)}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span>{formatMicroUsdc(remaining)}</span>
                      <div className="w-16 h-1.5 bg-gray-200 rounded overflow-hidden">
                        <div
                          className={`h-full rounded ${pct > 90 ? "bg-red-500" : pct > 70 ? "bg-yellow-500" : "bg-green-500"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${
                      auth.status === "active" ? "bg-green-100 text-green-700" :
                      auth.status === "revoked" ? "bg-red-100 text-red-700" :
                      "bg-yellow-100 text-yellow-700"
                    }`}>
                      {auth.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {new Date(auth.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2">
                    {auth.status === "active" && (
                      <button
                        onClick={() => handleRevoke(auth.serviceId)}
                        className="px-2 py-1 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatMicroUsdc(micro: number | string): string {
  const val = Number(micro);
  if (val === 0) return "0 USDC";
  return `${(val / 1_000_000).toFixed(6)} USDC`;
}
