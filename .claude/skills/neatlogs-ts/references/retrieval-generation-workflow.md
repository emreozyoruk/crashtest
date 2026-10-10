# Retrieval-and-generation workflow verification

Use this public pattern for any Next.js feature that retrieves context and then calls a supported model provider. Adapt the names to the application's real feature; do not copy names, paths, data, or secrets from another user's environment.

Expected hierarchy:

```text
WORKFLOW answer_with_context
├── RETRIEVER load_relevant_context   # only for custom retrieval code
└── LLM                               # owned by the provider/framework integration
```

1. Initialize once from Next.js `instrumentation.ts` through its exported `register()` hook. For an EU project, pass `endpoint: 'https://eu.ingest.neatlogs.com'` to `init()`. For other managed projects, omit the endpoint.
2. Use the matching wrapper, callback handler, hook, or processor for the model/framework. That integration owns the single LLM span; never surround the call with a second manual LLM `trace()` or `span()`.
3. Add a `WORKFLOW` span only when the real entry point performs multiple meaningful operations. Add a `RETRIEVER` span only when retrieval is custom code and no integration already captures it.
4. Run the repository's real build after adding or changing `instrumentation.ts`. A source edit or hot reload does not prove that the startup hook was compiled and loaded.
5. Stop the old process, start the newly built application, invoke the actual safe route/action, and confirm a new trace created after the verification start time. Verify exactly one LLM span, the expected retrieval I/O, and no duplicate manual layer.

If build, restart, path exercise, or live trace confirmation is unavailable, report the exact command and blocker and leave verification incomplete.
