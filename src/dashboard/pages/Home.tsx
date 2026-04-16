import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAccount, useConnect, useDisconnect, useBalance } from "wagmi";
import { base } from "wagmi/chains";
import { useQuery } from "@tanstack/react-query";

const DEMO_CODE_SNIPPET = `import { createAgentPayClient } from "@agentpay88/client";

const client = createAgentPayClient({ wallet: YOUR_WALLET });
const res = await client.fetch("https://agentpay.xyz/api/demo/echo");
console.log(await res.json());`;

export default function Home() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address, chainId: base.id });
  const [copied, setCopied] = useState(false);

  // Auto-seed demo service on load when wallet is connected
  useEffect(() => {
    if (!isConnected) return;
    fetch("/api/demo/setup").catch(() => {});
  }, [isConnected]);

  const { data: wallet } = useQuery({
    queryKey: ["wallet", address],
    queryFn: async () => {
      const res = await fetch(`/api/wallets/${address}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!address,
  });

  const { data: platformStats } = useQuery({
    queryKey: ["platformStats"],
    queryFn: async () => {
      const res = await fetch("/api/platform/stats");
      return res.json();
    },
  });

  const { data: recentUsage } = useQuery({
    queryKey: ["recentUsage", address],
    queryFn: async () => {
      const res = await fetch(`/api/wallets/${address}/usage?limit=5`);
      if (!res.ok) return { records: [] };
      return res.json();
    },
    enabled: !!address,
  });

  const { data: authData } = useQuery({
    queryKey: ["authorizations", address],
    queryFn: async () => {
      const res = await fetch(`/api/auth/${address}`);
      if (!res.ok) return { authorizations: [] };
      return res.json();
    },
    enabled: !!address,
  });

  const totalCalls = wallet?.totalSpent !== undefined ? Number(wallet.totalSpent) : undefined;
  const isNewUser = totalCalls === 0;
  const hasAuthorizations =
    authData?.authorizations && authData.authorizations.length > 0;
  const recentRecords: UsageRecord[] = recentUsage?.records ?? [];

  function handleCopy() {
    navigator.clipboard.writeText(DEMO_CODE_SNIPPET).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (!isConnected) {
    return (
      <div>
        <h2 className="text-xl font-bold mb-4">Connect Wallet</h2>
        <p className="text-gray-600 mb-4">Connect your wallet to access the AgentPay dashboard.</p>
        <div className="space-y-2">
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              onClick={() => connect({ connector })}
              className="block px-4 py-2 bg-gray-900 text-white rounded text-sm hover:bg-gray-700"
            >
              {connector.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">Dashboard</h2>
        <button
          onClick={() => disconnect()}
          className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100"
        >
          Disconnect
        </button>
      </div>

      {/* Welcome / onboarding block for new users */}
      {isNewUser && (
        <div className="bg-blue-50 border border-blue-200 rounded p-5 mb-6">
          <h3 className="text-base font-semibold text-blue-900 mb-1">Welcome to AgentPay</h3>
          <p className="text-sm text-blue-800 mb-4">
            AgentPay lets API developers charge micro-payments per call and lets agents pay
            autonomously — all tracked and capped by you.
          </p>
          <Link
            to="/services"
            className="inline-block px-4 py-2 bg-blue-700 text-white text-sm rounded hover:bg-blue-800 mb-4"
          >
            Try the Demo &rarr;
          </Link>
          <div>
            <div className="text-xs text-blue-700 font-medium mb-1 uppercase tracking-wide">
              Quick start with @agentpay88/client
            </div>
            <div className="relative">
              <pre className="bg-gray-900 text-green-300 text-xs rounded p-3 overflow-x-auto whitespace-pre">
                {DEMO_CODE_SNIPPET}
              </pre>
              <button
                onClick={handleCopy}
                className="absolute top-2 right-2 px-2 py-1 text-xs bg-gray-700 text-gray-200 rounded hover:bg-gray-600"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* No-authorization nudge */}
      {!isNewUser && !hasAuthorizations && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-4 mb-6 text-sm text-yellow-900">
          No active authorizations.{" "}
          <Link to="/services" className="underline font-medium hover:text-yellow-700">
            Authorize a service to start making paid API calls
          </Link>
          .
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border rounded p-4">
          <div className="text-xs text-gray-500 uppercase mb-1">Wallet</div>
          <div className="text-sm font-mono truncate">{address}</div>
        </div>
        <div className="bg-white border rounded p-4">
          <div className="text-xs text-gray-500 uppercase mb-1">ETH Balance</div>
          <div className="text-lg font-medium">
            {balance ? `${(Number(balance.value) / 10 ** balance.decimals).toFixed(4)} ${balance.symbol}` : "—"}
          </div>
        </div>
        <div className="bg-white border rounded p-4">
          <div className="text-xs text-gray-500 uppercase mb-1">Wallet Type</div>
          <div className="text-lg font-medium">{wallet?.type ?? "—"}</div>
        </div>
      </div>

      {wallet && (
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-white border rounded p-4">
            <div className="text-xs text-gray-500 uppercase mb-1">Total Spent</div>
            <div className="text-lg font-medium">{formatMicroUsdc(wallet.totalSpent)}</div>
          </div>
          <div className="bg-white border rounded p-4">
            <div className="text-xs text-gray-500 uppercase mb-1">Total Earned</div>
            <div className="text-lg font-medium">{formatMicroUsdc(wallet.totalEarned)}</div>
          </div>
        </div>
      )}

      {/* Recent activity */}
      {recentRecords.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-base font-semibold">Recent Activity</h3>
            <Link to="/history" className="text-sm text-blue-600 hover:underline">
              View all
            </Link>
          </div>
          <div className="bg-white border rounded divide-y">
            {recentRecords.map((r) => (
              <div key={r.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <span className="font-medium font-mono text-xs text-gray-700">{r.serviceId}</span>
                  <span
                    className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                      r.status === "success"
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
                <div className="text-right text-gray-500 text-xs">
                  <div>{formatMicroUsdc(r.grossAmount)}</div>
                  <div>{new Date(r.timestamp).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {platformStats && (
        <>
          <h3 className="text-base font-semibold mb-3">Platform Stats</h3>
          <div className="grid grid-cols-4 gap-4">
            <StatCard label="Total Services" value={platformStats.totalServices} />
            <StatCard label="Total Calls" value={platformStats.totalCalls} />
            <StatCard label="Total Volume" value={formatMicroUsdc(platformStats.totalVolume)} />
            <StatCard label="Total Fees" value={formatMicroUsdc(platformStats.totalFees)} />
          </div>
        </>
      )}
    </div>
  );
}

interface UsageRecord {
  id: string;
  serviceId: string;
  status: string;
  grossAmount: number;
  timestamp: string;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white border rounded p-4">
      <div className="text-xs text-gray-500 uppercase mb-1">{label}</div>
      <div className="text-lg font-medium">{value}</div>
    </div>
  );
}

function formatMicroUsdc(micro: number | string): string {
  const val = Number(micro);
  if (val === 0) return "0 USDC";
  return `${(val / 1_000_000).toFixed(6)} USDC`;
}
