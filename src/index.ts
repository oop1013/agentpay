import "dotenv/config";
import app from "./app";
import { initDemoService } from "./api/demo";

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AgentPay server running on port ${PORT}`);

  // Auto-initialize demo service — non-blocking, server accepts requests immediately
  initDemoService()
    .then((created) => {
      if (created) {
        console.log("[agentpay] Demo service initialized (svc_demo ready)");
      } else {
        console.log("[agentpay] Demo service already exists, skipping init");
      }
    })
    .catch((err) => {
      console.error("[agentpay] Failed to initialize demo service:", err);
    });
});

export default app;
