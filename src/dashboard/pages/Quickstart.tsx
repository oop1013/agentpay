import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount, useConnect } from "wagmi";
import { useQuery } from "@tanstack/react-query";

const DEMO_SERVICE_ID = "svc_demo";

const STEP4_SNIPPET = `import { createAgentPayClient, createEIP712Signer } from "@agentpay88/client";

// 1. Create a signer from your wallet private key
const signer = createEIP712Signer("0xYOUR_PRIVATE_KEY");

// 2. Create the client
const client = createAgentPayClient({
  callerWallet: "0xYOUR_WALLET_ADDRESS",
  signPayment: signer,
});

// 3. Call the demo echo endpoint — payment happens automatically
const res = await client.fetch("https://your-agentpay.vercel.app/api/demo/echo");
const data = await res.json();
console.log(data.message); // "Payment verified — welcome to the AgentPay Demo Echo API!"`;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-100"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function StepCard({
  num,
  title,
  children,
  done,
}: {
  num: number;
  title: string;
  children: React.ReactNode;
  done?: boolean;
}) {
  return (
    <div className={`bg-white border rounded p-5 ${done ? "border-green-400" : "border-gray-200"}`}>
      <div className="flex items-start gap-3">
        <div
          className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
            done ? "bg-green-500 text-white" : "bg-gray-900 text-white"
          }`}
        >
          {done ? "✓" : num}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 mb-2">{title}</h3>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function Quickstart() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();

  // Check if demo service exists
  const { data: demoService, isLoading: demoLoading } = useQuery({
    queryKey: ["demoService"],
    queryFn: async () => {
      const res = await fetch("/api/demo/setup");
      if (!res.ok) throw new Error("Demo setup failed");
      return res.json();
    },
    staleTime: 60_000,
  });

  // Check if user has an authorization for the demo service
  const { data: authorizations } = useQuery({
    queryKey: ["authorizations", address],
    queryFn: async () => {
      const res = await fetch(`/api/auth/${address}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.authorizations ?? [];
    },
    enabled: !!address,
  });

  const hasDemoAuth = authorizations?.some(
    (a: { serviceId: string; active: boolean }) =>
      a.serviceId === DEMO_SERVICE_ID && a.active
  );

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold mb-1">Quickstart</h2>
      <p className="text-gray-500 text-sm mb-6">
        Complete the loop in 5 steps: connect your wallet, authorize the demo
        service, and make a paid API call.
      </p>

      <div className="space-y-4">
        {/* Step 1 */}
        <StepCard num={1} title="Connect your wallet" done={isConnected}>
          {isConnected ? (
            <p className="text-sm text-gray-600">
              Connected as{" "}
              <span className="font-mono text-xs bg-gray-100 px-1 rounded">
                {address}
              </span>
            </p>
          ) : (
            <div>
              <p className="text-sm text-gray-600 mb-3">
                Connect a wallet to identify yourself as a buyer.
              </p>
              <div className="flex gap-2 flex-wrap">
                {connectors.map((connector) => (
                  <button
                    key={connector.uid}
                    onClick={() => connect({ connector })}
                    className="px-4 py-2 bg-gray-900 text-white rounded text-sm hover:bg-gray-700"
                  >
                    {connector.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </StepCard>

        {/* Step 2 */}
        <StepCard
          num={2}
          title="Demo service is auto-seeded"
          done={!!demoService}
        >
          {demoLoading ? (
            <p className="text-sm text-gray-500">Checking demo service…</p>
          ) : demoService ? (
            <div className="text-sm text-gray-600 space-y-1">
              <p>
                The <strong>Demo Echo API</strong> ({DEMO_SERVICE_ID}) is live
                at price{" "}
                <span className="font-mono text-xs bg-gray-100 px-1 rounded">
                  {demoService.service?.pricePerCall ?? 10000} µUSDC/call
                </span>
              </p>
              <p>
                <Link
                  to="/services"
                  className="text-blue-600 hover:underline text-xs"
                >
                  View on Services page →
                </Link>
              </p>
            </div>
          ) : (
            <p className="text-sm text-red-600">
              Demo setup failed — check that the AgentPay server is running.
            </p>
          )}
        </StepCard>

        {/* Step 3 */}
        <StepCard
          num={3}
          title="Authorize the demo service"
          done={hasDemoAuth}
        >
          <p className="text-sm text-gray-600 mb-2">
            Create a spend-cap authorization so the client can pay on your
            behalf.
          </p>
          <p className="text-sm text-gray-600 mb-2">
            Go to <Link to="/services" className="text-blue-600 hover:underline">Services</Link>, find{" "}
            <strong>Demo Echo API</strong>, and click{" "}
            <strong>Authorize</strong>. Set any cap you like (e.g.{" "}
            <span className="font-mono text-xs bg-gray-100 px-1 rounded">
              100000 µUSDC
            </span>
            ).
          </p>
          {hasDemoAuth && (
            <p className="text-sm text-green-600 font-medium">
              Authorization found for {DEMO_SERVICE_ID} ✓
            </p>
          )}
          {!hasDemoAuth && isConnected && (
            <Link
              to="/authorizations"
              className="inline-block mt-1 text-xs text-blue-600 hover:underline"
            >
              View Authorizations →
            </Link>
          )}
        </StepCard>

        {/* Step 4 */}
        <StepCard num={4} title="Make a test call with @agentpay88/client">
          <p className="text-sm text-gray-600 mb-3">
            Install the client SDK and call the demo endpoint. The client
            handles the 402 → sign → retry loop automatically.
          </p>
          <div className="bg-gray-950 rounded overflow-x-auto relative">
            <div className="absolute top-2 right-2">
              <CopyButton text={STEP4_SNIPPET} />
            </div>
            <pre className="text-xs text-green-300 p-4 leading-relaxed whitespace-pre-wrap">
              {STEP4_SNIPPET}
            </pre>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Install:{" "}
            <span className="font-mono bg-gray-100 px-1 rounded">
              npm install @agentpay88/client
            </span>
          </p>
        </StepCard>

        {/* Step 5 */}
        <StepCard num={5} title="Check your usage history">
          <p className="text-sm text-gray-600 mb-2">
            After a successful call, a usage record appears in{" "}
            <Link to="/history" className="text-blue-600 hover:underline">
              History
            </Link>
            . You'll see the gross amount, platform fee, and provider net for
            each call.
          </p>
          <Link
            to="/history"
            className="inline-block text-xs text-blue-600 hover:underline"
          >
            View History →
          </Link>
        </StepCard>
      </div>

      <div className="mt-8 p-4 bg-gray-50 border border-gray-200 rounded text-sm text-gray-600">
        <strong>Demo endpoint reference</strong>
        <ul className="mt-2 space-y-1 font-mono text-xs">
          <li>GET /api/demo/setup — seed the demo service (idempotent)</li>
          <li>GET /api/demo/echo — paywall-protected echo endpoint</li>
        </ul>
      </div>
    </div>
  );
}
