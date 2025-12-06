import { Router, Request, Response } from "express";
import {
  getGroqLogs,
  getPersistedGroqLogs,
  getAllRecentGroqLogs,
} from "../callContextManager";

const router = Router();

/**
 * GET /api/groq-logs
 * Returns all recent Groq LLM logs across all calls for dashboard display
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const allLogs = getAllRecentGroqLogs();

    return res.status(200).json({
      status: "ok",
      data: allLogs,
    });
  } catch (error: any) {
    console.error("Error fetching Groq logs:", error);
    return res.status(500).json({
      status: "error",
      message: error.message || "Failed to fetch Groq logs",
    });
  }
});

/**
 * GET /api/groq-logs/:callId
 * Returns Groq logs for a specific call
 */
router.get("/:callId", async (req: Request, res: Response) => {
  try {
    const { callId } = req.params;

    if (!callId) {
      return res.status(400).json({
        status: "error",
        message: "Missing callId parameter",
      });
    }

    // Try active context first, then persisted logs
    let logs = getGroqLogs(callId);
    if (logs.length === 0) {
      logs = getPersistedGroqLogs(callId);
    }

    return res.status(200).json({
      status: "ok",
      callId,
      logs,
    });
  } catch (error: any) {
    console.error(`Error fetching Groq logs for call ${req.params.callId}:`, error);
    return res.status(500).json({
      status: "error",
      message: error.message || "Failed to fetch Groq logs",
    });
  }
});

export default router;
