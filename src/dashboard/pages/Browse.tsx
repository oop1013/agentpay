import React, { useState, useRef } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { baseSepolia } from "wagmi/chains";

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

interface Service {
  id: string;
  name: string;
  description: string;
  category: string;
  pricePerCall: number;
  status: string;
  providerWallet: string;
  endpoint: string;
  totalCalls: number;
}

interface Authorization {
  serviceId: string;
  spendCap: number;
  spent: number;
  status: string;
}

type TryState =
  | { phase: "idle" }
  | { phase: "signing" }
  | { phase: "calling" }
  | { phase: "done"; ok: boolean; body: string }
  | { phase: "error"; message: string };

export default function Browse() {
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();

  // Service listing
  const { data: servicesData, isLoading: servicesLoading } = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const res = await fetch("/api/services");
      return res.json() as Promise<{ services: Service[] }>;
    },
  });

  // User authorizations (wallet-gated)
  const { data: authData } = useQuery({
    queryKey: ["authorizations", address],
    queryFn: async () => {
      const res = await fetch(`/api/auth/${address}`);
      return res.json() as Promise<{ authorizations: Authorization[] }>;
    },
    enabled: isConnected && !!address,
  });

  const authMap = React.useMemo(() => {
    const map: Record<string, Authorization> = {};
    for (const a of authData?.authorizations ?? []) {
      map[a.serviceId] = a;
    }
    return map;
  }, [authData]);

  // Authorization modal state
  const [authModal, setAuthModal] = useState<{ serviceId: string; serviceName: string } | null>(null);
  const [spendCapUsdc, setSpendCapUsdc] = useState("1.00");
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Try/call state
  const [tryServiceId, setTryServiceId] = useState<string | null>(null);
  const [tryState, setTryState] = useState<TryState>({ phase: "idle" });

  // Category filter
  const [filterCategory, setFilterCategory] = useState<string>("");

  const activeServices = (servicesData?.services ?? []).filter((s) => s.status === "active");
  const categories = Array.from(new Set(activeServices.map((s) => s.category).filter(Boolean)));
  const filtered = filterCategory
    ? activeServices.filter((s) => s.category === filterCategory)
    : activeServices;

  // wagmi typed data signer
  const { signTypedDataAsync } = useSignTypedData();

  // Keep a ref to pending try data so the sign callback can close over it
  const pendingTryRef = useRef<Service | null>(null);

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

  async function handleTry(svc: Service) {
    if (!address) return;
    pendingTryRef.current = svc;
    setTryServiceId(svc.id);
    setTryState({ phase: "signing" });

    try {
      // Build ERC-3009 ReceiveWithAuthorization typed data
      const nonceBytes = new Uint8Array(32);
      crypto.getRandomValues(nonceBytes);
      const nonce = ("0x" + Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;

      const nowSec = Math.floor(Date.now() / 1000);
      const validAfter = BigInt(nowSec - 60);
      const validBefore = BigInt(nowSec + 300);
      const value = BigInt(svc.pricePerCall);
      const from = address as `0x${string}`;
      const to = svc.providerWallet.toLowerCase() as `0x${string}`;

      const signature = await signTypedDataAsync({
        domain: {
          name: "USD Coin",
          version: "2",
          chainId: baseSepolia.id,
          verifyingContract: USDC_ADDRESS,
        },
        types: {
          ReceiveWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "ReceiveWithAuthorization",
        message: { from, to, value, validAfter, validBefore, nonce },
      });

      // Encode payment proof as base64 JSON (x402 format)
      const proofObj = {
        from: address,
        to: svc.providerWallet,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
        signature,
        chainId: baseSepolia.id,
      };
      const proofB64 = btoa(JSON.stringify(proofObj));

      setTryState({ phase: "calling" });

      const startMs = Date.now();
      let ok = false;
      let body = "";

      try {
        const response = await fetch(svc.endpoint, {
          method: "GET",
          headers: {
            "X-Payment": proofB64,
            "X-Payment-Caller": address,
          },
        });
        ok = response.ok || response.status === 200;
        const text = await response.text();
        body = text.slice(0, 800);
      } catch (fetchErr) {
        // CORS or network error — proof was signed but call couldn't complete from browser
        ok = false;
        body = `Could not reach service endpoint from browser: ${(fetchErr as Error).message}. The signed payment proof is ready — use @agentpay/client or curl to submit it directly.`;
      }

      const latencyMs = Date.now() - startMs;

      // Record usage against AgentPay backend (proof-verified server-side)
      // Only attempt if we got a response (not a CORS/network failure)
      if (ok) {
        await fetch("/api/pay/record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceId: svc.id,
            callerWallet: address,
            status: "success",
            latencyMs,
            paymentProof: proofB64,
          }),
        });
        queryClient.invalidateQueries({ queryKey: ["usage", address] });
      }

      setTryState({ phase: "done", ok, body });
    } catch (err) {
      const msg = (err as Error).message ?? "Unknown error";
      setTryState({ phase: "error", message: msg });
    }
  }

  function resetTry() {
    setTryServiceId(null);
    setTryState({ phase: "idle" });
    pendingTryRef.current = null;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Browse Services</h2>
        {categories.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Filter:</span>
            <button
              onClick={() => setFilterCategory("")}
              className={`px-2 py-1 rounded text-xs border ${!filterCategory ? "bg-gray-900 text-white border-gray-900" : "text-gray-600 hover:bg-gray-50"}`}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setFilterCategory(cat)}
                className={`px-2 py-1 rounded text-xs border ${filterCategory === cat ? "bg-gray-900 text-white border-gray-900" : "text-gray-600 hover:bg-gray-50"}`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

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

      {/* Try/call result modal */}
      {tryServiceId && tryState.phase !== "idle" && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 w-[480px]">
            {tryState.phase === "signing" && (
              <div className="text-center py-4">
                <div className="text-sm font-medium text-gray-700 mb-2">Waiting for wallet signature…</div>
                <p className="text-xs text-gray-500">Approve the EIP-712 payment authorization in your wallet.</p>
              </div>
            )}
            {tryState.phase === "calling" && (
              <div className="text-center py-4">
                <div className="text-sm font-medium text-gray-700 mb-2">Calling service endpoint…</div>
                <p className="text-xs text-gray-500">Submitting signed payment proof and awaiting response.</p>
              </div>
            )}
            {tryState.phase === "done" && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${tryState.ok ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                    {tryState.ok ? "Success" : "Attempted"}
                  </span>
                  <span className="text-sm font-medium text-gray-700">
                    {tryState.ok ? "Call completed" : "Call attempted"}
                  </span>
                </div>
                <div className="bg-gray-50 border rounded p-3 mb-3 overflow-auto max-h-40">
                  <pre className="text-xs text-gray-700 whitespace-pre-wrap break-all">{tryState.body || "(empty response)"}</pre>
                </div>
                {tryState.ok && (
                  <p className="text-xs text-green-700 mb-3">Usage recorded — check History to see this call.</p>
                )}
              </div>
            )}
            {tryState.phase === "error" && (
              <div>
                <div className="text-sm font-medium text-red-700 mb-2">Error</div>
                <p className="text-xs text-gray-600 break-all">{tryState.message}</p>
              </div>
            )}
            {(tryState.phase === "done" || tryState.phase === "error") && (
              <button
                onClick={resetTry}
                className="mt-4 px-3 py-1.5 bg-gray-900 text-white rounded text-sm hover:bg-gray-700"
              >
                Close
              </button>
            )}
            {tryState.phase === "signing" || tryState.phase === "calling" ? (
              <button
                onClick={resetTry}
                className="mt-4 px-3 py-1.5 border rounded text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      )}

      {servicesLoading ? (
        <p className="text-gray-500 text-sm">Loading services…</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white border rounded p-10 text-center">
          <p className="text-gray-700 font-medium mb-1">No active services found.</p>
          <p className="text-gray-500 text-sm">Services registered by providers will appear here.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((svc) => {
            const auth = authMap[svc.id];
            const isAuthorized = auth?.status === "active";
            const remaining = isAuthorized ? auth.spendCap - auth.spent : 0;
            const isTrying = tryServiceId === svc.id && tryState.phase !== "idle";

            return (
              <div key={svc.id} className="bg-white border rounded-lg p-4 flex flex-col">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0 pr-2">
                    <h3 className="font-semibold text-gray-900 truncate">{svc.name}</h3>
                    <p className="text-xs text-gray-400 font-mono mt-0.5">{truncateAddress(svc.providerWallet)}</p>
                  </div>
                  <span className="shrink-0 inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                    {svc.category}
                  </span>
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

                  {isAuthorized && (
                    <div className="mb-3 bg-green-50 rounded px-2 py-1.5 text-xs text-green-700 flex justify-between">
                      <span>Authorized</span>
                      <span>{formatMicroUsdc(remaining)} remaining</span>
                    </div>
                  )}

                  {!isConnected ? (
                    <p className="text-xs text-gray-400 text-center">Connect wallet to use</p>
                  ) : !isAuthorized ? (
                    <button
                      onClick={() => { setAuthModal({ serviceId: svc.id, serviceName: svc.name }); setAuthStatus(null); setSpendCapUsdc("1.00"); }}
                      className="w-full px-3 py-1.5 bg-gray-900 text-white rounded text-sm hover:bg-gray-700"
                    >
                      Authorize
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleTry(svc)}
                        disabled={isTrying}
                        className="flex-1 px-3 py-1.5 bg-gray-900 text-white rounded text-sm hover:bg-gray-700 disabled:opacity-50"
                      >
                        {isTrying ? "Calling…" : "Try"}
                      </button>
                      <button
                        onClick={() => { setAuthModal({ serviceId: svc.id, serviceName: svc.name }); setAuthStatus(null); setSpendCapUsdc("1.00"); }}
                        className="px-3 py-1.5 border rounded text-sm hover:bg-gray-50 text-xs"
                      >
                        Edit cap
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
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

function truncateAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
