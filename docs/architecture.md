# Initial architecture

```text
Channel webhooks -> API -> event/workflow worker -> AI and business tools
                         |                 |
                         v                 v
                   PostgreSQL           Redis / queues
```

The API is the system boundary for the dashboard and providers. The worker performs delayed or retryable work such as follow-ups, AI qualification, and order processing. PostgreSQL remains the source of truth for each business and its unified customer timeline.
