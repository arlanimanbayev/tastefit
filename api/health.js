// GET /api/health: which modes are active (live Qloo or demo data, Gemini or scripted planner).
import { handleHealth } from '../lib/http.js';

export default handleHealth;
