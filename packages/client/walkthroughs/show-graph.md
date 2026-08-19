## The pipeline graph

The graph renders stages, jobs, and their relationships:

- **Stages** view lays jobs out in columns by stage; **Needs** view lays them out by
  `needs:` / `dependencies:` (a DAG).
- Badges flag manual ▶, allow-failure ⚠, trigger ↗, parallel ×N, matrix ⊞, services ⚙,
  and environment 🌐 jobs.
- **Click** a job to inspect/edit it; **double-click** to jump to its source.
- **Tab / arrow keys** move focus between jobs, **Enter** opens details.
- **Filter jobs…** dims everything except matches — handy for large pipelines.
- **Export PNG** saves the whole graph as an image.
