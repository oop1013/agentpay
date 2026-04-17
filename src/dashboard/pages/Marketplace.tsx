import React, { useState } from "react";
import { useAccount } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";

interface Service {
  id: string;
  name: string;
  description: string;
  category: string;
  pricePerCall: number;
  status: string;
  totalCalls: number;
  providerWallet: string;
  endpoint: string;
}

export default function Marketplace() {
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [category, setCategory] = useState("");
  const [sortBy, setSortBy] = useState<"newest" | "popular">("newest");

  // Authorization modal
  const [authModal, setAuthModal] = useState<{ serviceId: string; serviceName: string } | null>(null);
  const [spendCapUsdc, setSpendCapUsdc] = useState("1.00");
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  const queryParams = new URLSearchParams({ status: "active", sortBy });
  if (search) queryParams.set("search", search);
  if (category) queryParams.set("category", category);

  const { data, isLoading } = useQuery({
    queryKey: ["marketplace", search, category, sortBy],
    queryFn: async () => {
      const res = await fetch(`/api/services?${queryParams.toString()}`);
      return res.json() as Promise<{ services: Service[]; categories?: string[] }>;
    },
  });

  // Fetch all active services once to build category list
  const { data: allData } = useQuery({
    queryKey: ["marketplace-categories"],
    queryFn: async () => {
      const res = await fetch("/api/services?status=active");
      return res.json() as Promise<{ services: Service[] }>;
    },
  });

  const categories = React.useMemo(() => {
    const all = allData?.services ?? [];
    return Array.from(new Set(all.map((s) => s.category).filter(Boolean))).sort();
  }, [allData]);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSearch(searchInput.trim());
  }

  function clearSearch() {
    setSearchInput("");
    setSearch("");
  }

  async function handleAuthorize(e: React.FormEvent) {
    e.preventDefault();
    if (!authModal || !address) return;
    setAuthLoading(true);
    setAuthStatus(null);

    const spendCapMicro = Math.round(parseFloat(spendCapUsdc) * 1_000_000);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callerWallet: address,
        serviceId: authModal.serviceId,
        spendCap: spendCapMicro,
      }),
    });

    if (res.ok) {
      setAuthStatus("Authorized successfully.");
      setAuthModal(null);
      queryClient.invalidateQueries({ queryKey: ["authorizations", address] });
    } else {
      const err = await res.json();
      setAuthStatus(`Error: ${err.error}`);
    }
    setAuthLoading(false);
  }

  const services = data?.services ?? [];

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold mb-1">Marketplace</h2>
        <p className="text-sm text-gray-500">Browse and authorize paid API services.</p>
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* Search */}
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-1">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search services…"
            className="border rounded px-2 py-1 text-sm w-48"
          />
          <button
            type="submit"
            className="px-2 py-1 bg-gray-900 text-white rounded text-sm hover:bg-gray-700"
          >
            Search
          </button>
          {search && (
            <button
              type="button"
              onClick={clearSearch}
              className="px-2 py-1 border rounded text-sm text-gray-500 hover:bg-gray-50"
            >
              Clear
            </button>
          )}
        </form>

        {/* Sort */}
        <div className="flex items-center gap-1 ml-2">
          <span className="text-xs text-gray-500">Sort:</span>
          <button
            onClick={() => setSortBy("newest")}
            className={`px-2 py-1 rounded text-xs border ${sortBy === "newest" ? "bg-gray-900 text-white border-gray-900" : "text-gray-600 hover:bg-gray-50"}`}
          >
            Newest
          </button>
          <button
            onClick={() => setSortBy("popular")}
            className={`px-2 py-1 rounded text-xs border ${sortBy === "popular" ? "bg-gray-900 text-white border-gray-900" : "text-gray-600 hover:bg-gray-50"}`}
          >
            Popular
          </button>
        </div>
      </div>

      {/* Category filter */}
      {categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-5">
          <span className="text-xs text-gray-500 mr-1">Category:</span>
          <button
            onClick={() => setCategory("")}
            className={`px-2 py-1 rounded text-xs border ${!category ? "bg-gray-900 text-white border-gray-900" : "text-gray-600 hover:bg-gray-50"}`}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat === category ? "" : cat)}
              className={`px-2 py-1 rounded text-xs border ${category === cat ? "bg-gray-900 text-white border-gray-900" : "text-gray-600 hover:bg-gray-50"}`}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Authorization modal */}
      {authModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 w-96">
            <h3 className="text-base font-bold mb-1">Authorize Service</h3>
            <p className="text-sm text-gray-600 mb-4">{authModal.serviceName}</p>
            <form onSubmit={handleAuthorize} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Spend Cap (USDC)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={spendCapUsdc}
                    onChange={(e) => setSpendCapUsdc(e.target.value)}
                    className="border rounded px-2 py-1 text-sm w-36"
                    min="0.000001"
                    step="0.000001"
                    placeholder="1.00"
                    required
                  />
                  <span className="text-xs text-gray-500">USDC max spend</span>
                </div>
              </div>
              {authStatus && (
                <div className={`p-2 rounded text-xs ${authStatus.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
                  {authStatus}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={authLoading}
                  className="px-3 py-1.5 bg-gray-900 text-white rounded text-sm hover:bg-gray-700 disabled:opacity-50"
                >
                  {authLoading ? "Authorizing…" : "Authorize"}
                </button>
                <button
                  type="button"
                  onClick={() => { setAuthModal(null); setAuthStatus(null); }}
                  className="px-3 py-1.5 border rounded text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Results */}
      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading services…</p>
      ) : services.length === 0 ? (
        <div className="bg-white border rounded p-10 text-center">
          <p className="text-gray-700 font-medium mb-1">No services found.</p>
          <p className="text-gray-500 text-sm">
            {search || category ? "Try adjusting your filters." : "No active services are available yet."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {services.map((svc) => (
            <div key={svc.id} className="bg-white border rounded-lg p-4 flex flex-col">
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0 pr-2">
                  <h3 className="font-semibold text-gray-900 truncate">{svc.name}</h3>
                </div>
                {svc.category && (
                  <span className="shrink-0 inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                    {svc.category}
                  </span>
                )}
              </div>

              <p className="text-sm text-gray-600 mb-3 flex-1 line-clamp-3">
                {svc.description || "No description provided."}
              </p>

              <div className="border-t pt-3 mt-auto">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="text-xs text-gray-500">Price per call</span>
                    <div className="font-mono text-sm font-semibold text-gray-900">
                      {formatMicroUsdc(svc.pricePerCall)}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-gray-500">Total calls</span>
                    <div className="text-sm text-gray-700">{svc.totalCalls.toLocaleString()}</div>
                  </div>
                </div>

                {!isConnected ? (
                  <p className="text-xs text-gray-400 text-center">Connect wallet to authorize</p>
                ) : (
                  <button
                    onClick={() => {
                      setAuthModal({ serviceId: svc.id, serviceName: svc.name });
                      setAuthStatus(null);
                      setSpendCapUsdc("1.00");
                    }}
                    className="w-full px-3 py-1.5 bg-gray-900 text-white rounded text-sm hover:bg-gray-700"
                  >
                    Authorize
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatMicroUsdc(micro: number | string): string {
  const val = Number(micro);
  if (val === 0) return "0 USDC";
  const usdc = val / 1_000_000;
  if (usdc < 0.01) return `${usdc.toFixed(6)} USDC`;
  return `${usdc.toFixed(4)} USDC`;
}
