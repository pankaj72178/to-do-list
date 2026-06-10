// =====================================================================
// To-do / Task REST API — Express + MongoDB (Mongoose)
// Works BOTH locally (app.listen) and on Vercel (serverless export).
// =====================================================================

require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const app = express();
const MONGODB_URI = process.env.MONGODB_URI;

app.use(express.json());

// ---------------------------------------------------------------------
// Database connection (serverless-friendly, cached across invocations)
// ---------------------------------------------------------------------
// On Vercel, each request may run in a fresh container. We cache the
// connection promise on a module-level variable so warm invocations reuse
// the existing connection instead of opening a new one every time.
let cachedConn = null;
async function connectDB() {
  if (!MONGODB_URI) {
    throw new Error("Missing MONGODB_URI environment variable");
  }
  if (cachedConn) return cachedConn;
  // bufferCommands:false makes queries fail fast if not connected (better in serverless)
  cachedConn = mongoose.connect(MONGODB_URI, { bufferCommands: false });
  await cachedConn;
  return cachedConn;
}

// Make sure the DB is connected before any route runs. If it can't connect,
// the error flows to the error handler as a clean 500 — it never crashes
// the whole function (which is what caused FUNCTION_INVOCATION_FAILED).
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Schema & Model
// ---------------------------------------------------------------------
const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    completed: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: (doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
      },
    },
  }
);

// Reuse the model if it already exists (prevents OverwriteModelError on
// hot reloads / repeated serverless imports).
const Task = mongoose.models.Task || mongoose.model("Task", taskSchema);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
function isValidTitle(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

// GET / — root route, confirms the API is running.
app.get(
  "/",
  wrap((req, res) => {
    res.json({
      message: "Task REST API (MongoDB) is running.",
      endpoints: {
        "GET /tasks": "List all tasks",
        "GET /tasks/:id": "Get a single task",
        "POST /tasks": "Create a task { title }",
        "PUT /tasks/:id": "Update a task { title?, completed? }",
        "DELETE /tasks/:id": "Delete a task",
      },
    });
  })
);

// GET /tasks — list all tasks, newest first.
app.get(
  "/tasks",
  wrap(async (req, res) => {
    const tasks = await Task.find().sort({ createdAt: -1 });
    res.status(200).json(tasks);
  })
);

// GET /tasks/:id — one task, or 404.
app.get(
  "/tasks/:id",
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Task not found" });
    }
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.status(200).json(task);
  })
);

// POST /tasks — create from { title }.
app.post(
  "/tasks",
  wrap(async (req, res) => {
    const { title } = req.body || {};
    if (!isValidTitle(title)) {
      return res
        .status(400)
        .json({ error: "Title is required and must be a non-empty string" });
    }
    const task = await Task.create({ title: title.trim(), completed: false });
    res.status(201).json(task);
  })
);

// PUT /tasks/:id — update title and/or completed.
app.put(
  "/tasks/:id",
  wrap(async (req, res) => {
    const { title, completed } = req.body || {};
    if (title !== undefined && !isValidTitle(title)) {
      return res
        .status(400)
        .json({ error: "Title, if provided, must be a non-empty string" });
    }
    if (completed !== undefined && typeof completed !== "boolean") {
      return res
        .status(400)
        .json({ error: "Completed, if provided, must be a boolean" });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Task not found" });
    }
    const updates = {};
    if (title !== undefined) updates.title = title.trim();
    if (completed !== undefined) updates.completed = completed;

    const task = await Task.findByIdAndUpdate(req.params.id, updates, {
      returnDocument: "after",
      runValidators: true,
    });
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.status(200).json(task);
  })
);

// DELETE /tasks/:id — remove a task.
app.delete(
  "/tasks/:id",
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Task not found" });
    }
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.status(200).json({ message: "Task deleted", task });
  })
);

// ---------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "Invalid JSON in request body" });
  }
  if (err.name === "ValidationError") {
    return res.status(400).json({ error: err.message });
  }
  if (err.name === "CastError") {
    return res.status(404).json({ error: "Task not found" });
  }
  console.error(err);
  // TEMPORARY DEBUG: expose the real error so we can diagnose the Vercel
  // deployment. Remove `detail`/`name` once the connection works.
  res.status(500).json({
    error: "Internal server error",
    name: err.name,
    detail: err.message,
  });
});

// ---------------------------------------------------------------------
// Start / export
// ---------------------------------------------------------------------
// Locally: start a normal server. On Vercel: DON'T listen — just export the
// app so Vercel's serverless runtime can invoke it per request.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () =>
    console.log(`Task API listening on http://localhost:${PORT}`)
  );
}

module.exports = app;
