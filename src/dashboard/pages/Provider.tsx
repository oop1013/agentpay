import React from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";

interface Service {
  id: string;
  name: string;
  category: string;
  pricePerCall: number;
  providerWallet: string;
  status: string;
  totalCalls: number;
  grossVolume: number;
  totalEarned: number;
  totalFees: number;
  createdAt: string;
}

export default function Provider() {
  const navigate = useNavigate();
  const { address, isConnected } = useAccount();

  const { data, isLoading } = useQuery({
    queryKey: ["providerServices", address],
    queryFn: async () => {
      const res = await fetch("/api/services");
      const json = await res.json() as { services: Service[] };
      return json.services.filter(
        (s) => s.providerWallet === address?.toLowerCase()
      );
    },
    enabled: isConnected,
  });

  if (!isConnected) {
    return <p className="text-gray-500 text-sm">Connect wallet to view provider dashboard.</p>;
  }

  const totalEarned = data?.reduce((sum, s) => sum + Number(s.totalEarned), 0) ?? 0;
  const totalFees = data?.reduce((sum, s) => sum + Number(s.totalFees), 0) ?? 0;
  const totalVolume = data?.reduce((sum, s) => sum + Number(s.grossVolume), 0) ?? 0;
  const totalCalls = data?.reduce((sum, s) => sum + Number(s.totalCalls), 0) ?? 0;

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Provider Dashboard</h2>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Net Earnings" value={formatMicroUsdc(totalEarned)} />
        <StatCard label="Platform Fees Paid" value={formatMicroUsdc(totalFees)} />
        <StatCard label="Gross Volume" value={formatMicroUsdc(totalVolume)} />
        <StatCard label="Total Calls" value={totalCalls} />
      </div>

      <h3 className="text-lg font-bold mb-3">Your Services</h3>

      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : !data?.length ? (
        <div className="bg-white border rounded p-8 text-center">
          <p className="text-gray-700 font-medium mb-1">You haven't registered any services yet.</p>
          <p className="text-gray-500 text-sm mb-4">Register a service to start earning from paid API calls.</p>
          <button
            onClick={() => navigate("/services")}
            className="px-4 py-2 bg-gray-900 text-white rounded text-sm hover:bg-gray-700"
          >
            Register a Service
          </button>
        </div>
      ) : (
        <table className="w-full bg-white border rounded text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-4 py-2">Service</th>
              <th className="px-4 py-2">Price</th>
              <th className="px-4 py-2">Calls</th>
              <th className="px-4 py-2">Gross Volume</th>
              <th className="px-4 py-2">Net Earned</th>
              <th className="px-4 py-2">Fees Paid</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((svc) => (
              <tr key={svc.id} className="border-b hover:bg-gray-50">
                <td className="px-4 py-2">
                  <div className="font-medium">{svc.name}</div>
                  <div className="text-xs text-gray-400 font-mono">{svc.id}</div>
                </td>
                <td className="px-4 py-2">{formatMicroUsdc(svc.pricePerCall)}</td>
                <td className="px-4 py-2">{svc.totalCalls}</td>
                <td className="px-4 py-2">{formatMicroUsdc(svc.grossVolume)}</td>
                <td className="px-4 py-2">{formatMicroUsdc(svc.totalEarned)}</td>
                <td className="px-4 py-2">{formatMicroUsdc(svc.totalFees)}</td>
                <td className="px-4 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs ${svc.status === "active" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                    {svc.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
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
