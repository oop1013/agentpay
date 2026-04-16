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

interface RegisterForm {
  name: string;
  endpoint: string;
  pricePerCall: string;
  description: string;
  category: string;
}

const EMPTY_REGISTER_FORM: RegisterForm = {
  name: "",
  endpoint: "",
  pricePerCall: "",
  description: "",
  category: "",
};

export default function Services() {
  const { address } = useAccount();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const res = await fetch("/api/services");
      return res.json() as Promise<{ services: Service[] }>;
    },
  });

  // spendCap stored as USDC string (e.g. "1.00"), converted on submit
  const [authForm, setAuthForm] = useState<{ serviceId: string; serviceName: string; spendCapUsdc: string } | null>(null);
  const [authStatus, setAuthStatus] = useState<string | null>(null);

  const [showRegister, setShowRegister] = useState(false);
  const [registerForm, setRegisterForm] = useState<RegisterForm>(EMPTY_REGISTER_FORM);
  const [registerStatus, setRegisterStatus] = useState<string | null>(null);
  const [registerLoading, setRegisterLoading] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(key);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }

  async function handleAuthorize(e: React.FormEvent) {
    e.preventDefault();
    if (!authForm || !address) return;

    setAuthStatus(null);
    const spendCapMicro = Math.round(parseFloat(authForm.spendCapUsdc) * 1_000_000);

    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callerWallet: address,
        serviceId: authForm.serviceId,
        spendCap: spendCapMicro,
      }),
    });

    if (res.ok) {
      setAuthStatus("Authorized");
      setAuthForm(null);
    } else {
      const err = await res.json();
      setAuthStatus(`Error: ${err.error}`);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!address) return;

    setRegisterStatus(null);
    setRegisterLoading(true);

    const priceInMicroUsdc = Math.round(parseFloat(registerForm.pricePerCall) * 1_000_000);

    try {
      const res = await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: registerForm.name,
          endpoint: registerForm.endpoint,
          pricePerCall: priceInMicroUsdc,
          description: registerForm.description,
          category: registerForm.category,
          providerWallet: address,
        }),
      });

      if (res.ok) {
        setRegisterStatus("Service registered successfully.");
        setRegisterForm(EMPTY_REGISTER_FORM);
        setShowRegister(false);
        queryClient.invalidateQueries({ queryKey: ["services"] });
      } else {
        const err = await res.json();
        setRegisterStatus(`Error: ${err.error ?? "Registration failed"}`);
      }
    } catch {
      setRegisterStatus("Error: Network error. Please try again.");
    } finally {
      setRegisterLoading(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Services</h2>
        {address && !showRegister && (
          <button
            onClick={() => { setShowRegister(true); setRegisterStatus(null); }}
            className="px-3 py-1.5 bg-gray-900 text-white rounded text-sm hover:bg-gray-700"
          >
            Register Service
          </button>
        )}
      </div>

      {registerStatus && (
        <div className={`mb-4 p-3 rounded text-sm ${registerStatus.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {registerStatus}
        </div>
      )}

      {showRegister && address && (
        <form onSubmit={handleRegister} className="mb-6 bg-white border rounded p-4 space-y-3">
          <h3 className="text-sm font-bold mb-1">Register a New Service</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Service Name</label>
              <input
                type="text"
                value={registerForm.name}
                onChange={(e) => setRegisterForm({ ...registerForm, name: e.target.value })}
                className="border rounded px-2 py-1 text-sm w-full"
                placeholder="My API Service"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Category</label>
              <input
                type="text"
                value={registerForm.category}
                onChange={(e) => setRegisterForm({ ...registerForm, category: e.target.value })}
                className="border rounded px-2 py-1 text-sm w-full"
                placeholder="data, ml, finance, …"
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Endpoint URL</label>
            <input
              type="url"
              value={registerForm.endpoint}
              onChange={(e) => setRegisterForm({ ...registerForm, endpoint: e.target.value })}
              className="border rounded px-2 py-1 text-sm w-full"
              placeholder="https://api.example.com/endpoint"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Price Per Call (USDC)</label>
            <input
              type="number"
              value={registerForm.pricePerCall}
              onChange={(e) => setRegisterForm({ ...registerForm, pricePerCall: e.target.value })}
              className="border rounded px-2 py-1 text-sm w-48"
              placeholder="0.01"
              min="0.000001"
              step="0.000001"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Description</label>
            <textarea
              value={registerForm.description}
              onChange={(e) => setRegisterForm({ ...registerForm, description: e.target.value })}
              className="border rounded px-2 py-1 text-sm w-full"
              rows={2}
              placeholder="Describe what this service does."
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Provider Wallet</label>
            <input
              type="text"
              value={address}
              readOnly
              className="border rounded px-2 py-1 text-sm w-full bg-gray-50 text-gray-500 font-mono text-xs"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={registerLoading}
              className="px-3 py-1.5 bg-gray-900 text-white rounded text-sm hover:bg-gray-700 disabled:opacity-50"
            >
              {registerLoading ? "Registering…" : "Register"}
            </button>
            <button
              type="button"
              onClick={() => { setShowRegister(false); setRegisterForm(EMPTY_REGISTER_FORM); }}
              className="px-3 py-1.5 border rounded text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {authStatus && (
        <div className={`mb-4 p-3 rounded text-sm ${authStatus.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {authStatus}
        </div>
      )}

      {authForm && (
        <form onSubmit={handleAuthorize} className="mb-4 bg-white border rounded p-4">
          <h3 className="text-sm font-bold mb-3">Authorize: {authForm.serviceName}</h3>
          <div className="mb-3">
            <label className="block text-xs text-gray-600 mb-1">Spend Cap (USDC)</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={authForm.spendCapUsdc}
                onChange={(e) => setAuthForm({ ...authForm, spendCapUsdc: e.target.value })}
                className="border rounded px-2 py-1 text-sm w-36"
                min="0.000001"
                step="0.000001"
                placeholder="1.00"
                required
              />
              <span className="text-xs text-gray-500">USDC</span>
              {authForm.spendCapUsdc && !isNaN(parseFloat(authForm.spendCapUsdc)) && (
                <span className="text-xs text-gray-400">
                  = {Math.round(parseFloat(authForm.spendCapUsdc) * 1_000_000).toLocaleString()} micro-USDC
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="px-3 py-1 bg-gray-900 text-white rounded text-sm hover:bg-gray-700">
              Confirm
            </button>
            <button type="button" onClick={() => setAuthForm(null)} className="px-3 py-1 border rounded text-sm">
              Cancel
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : !data?.services?.length ? (
        <div className="text-gray-500 text-sm bg-white border rounded p-6 text-center">
          <p className="font-medium mb-1">No services registered yet.</p>
          {address
            ? <p>Click <strong>Register Service</strong> above to add your first paid API.</p>
            : <p>Connect your wallet to register a service.</p>
          }
        </div>
      ) : (
        <table className="w-full bg-white border rounded text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Category</th>
              <th className="px-4 py-2">Endpoint</th>
              <th className="px-4 py-2">Price</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Calls</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {data.services.map((svc) => (
              <React.Fragment key={svc.id}>
                <tr className="border-b hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <div className="font-medium">{svc.name}</div>
                    <div className="text-xs text-gray-400 font-mono">{svc.id}</div>
                  </td>
                  <td className="px-4 py-2">{svc.category}</td>
                  <td className="px-4 py-2 max-w-xs">
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-xs text-gray-700 truncate max-w-[180px]" title={svc.endpoint}>
                        {svc.endpoint}
                      </span>
                      <button
                        onClick={() => copyToClipboard(svc.endpoint, `ep-${svc.id}`)}
                        className="shrink-0 text-xs text-gray-400 hover:text-gray-700 px-1"
                        title="Copy URL"
                      >
                        {copiedId === `ep-${svc.id}` ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-2">{formatMicroUsdc(svc.pricePerCall)}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${svc.status === "active" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                      {svc.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">{svc.totalCalls}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleExpand(svc.id)}
                        className="px-2 py-1 border rounded text-xs hover:bg-gray-100"
                      >
                        {expandedId === svc.id ? "Hide" : "Details"}
                      </button>
                      {address && (
                        <button
                          onClick={() => setAuthForm({ serviceId: svc.id, serviceName: svc.name, spendCapUsdc: "1.00" })}
                          className="px-2 py-1 border rounded text-xs hover:bg-gray-100"
                        >
                          Authorize
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedId === svc.id && (
                  <tr className="border-b bg-gray-50">
                    <td colSpan={7} className="px-6 py-4">
                      <div className="grid grid-cols-2 gap-6 text-sm">
                        <div>
                          <div className="mb-3">
                            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Description</span>
                            <p className="mt-1 text-gray-700">{svc.description || "No description provided."}</p>
                          </div>
                          <div className="mb-3">
                            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Endpoint URL</span>
                            <div className="mt-1 flex items-center gap-2">
                              <code className="font-mono text-xs bg-white border rounded px-2 py-1 text-gray-800 break-all">{svc.endpoint}</code>
                              <button
                                onClick={() => copyToClipboard(svc.endpoint, `detail-ep-${svc.id}`)}
                                className="shrink-0 text-xs text-gray-400 hover:text-gray-700 border rounded px-2 py-1"
                              >
                                {copiedId === `detail-ep-${svc.id}` ? "Copied!" : "Copy"}
                              </button>
                            </div>
                          </div>
                          <div className="mb-3">
                            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Price per call</span>
                            <p className="mt-1 text-gray-700">{formatMicroUsdc(svc.pricePerCall)}</p>
                          </div>
                          <div>
                            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Provider wallet</span>
                            <p className="mt-1 font-mono text-xs text-gray-600">{truncateAddress(svc.providerWallet)}</p>
                          </div>
                        </div>
                        <div>
                          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Integration</span>
                          <div className="mt-1 relative">
                            <pre className="bg-gray-900 text-gray-100 rounded p-3 text-xs overflow-x-auto leading-relaxed">{`import { payFetch } from '@agentpay/client';\n\nconst res = await payFetch('${svc.endpoint}');`}</pre>
                            <button
                              onClick={() => copyToClipboard(`import { payFetch } from '@agentpay/client';\n\nconst res = await payFetch('${svc.endpoint}');`, `snippet-${svc.id}`)}
                              className="absolute top-2 right-2 text-xs text-gray-400 hover:text-white border border-gray-600 rounded px-2 py-0.5"
                            >
                              {copiedId === `snippet-${svc.id}` ? "Copied!" : "Copy"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
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

function truncateAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
