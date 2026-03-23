/**
 * Slurm 23.11 REST API (slurmrestd v0.0.39) — inline schema definitions.
 *
 * These schemas represent the three declarative resource types exposed by the
 * Slurm REST API that chant users write as TypeScript. The full slurmrestd
 * OpenAPI spec is generated at runtime by slurmrestd and is not distributed
 * as a static artifact, so we bundle the relevant subset here.
 *
 * Source: https://slurm.schedmd.com/rest_api.html (Slurm 23.11 / v0.0.39)
 */

export interface SlurmPropDef {
  type: "string" | "integer" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
  items?: { type: string };
  format?: "int32" | "int64";
}

export interface SlurmResourceDef {
  typeName: string;
  description: string;
  properties: Record<string, SlurmPropDef>;
}

export const SLURM_REST_RESOURCES: SlurmResourceDef[] = [
  {
    typeName: "Slurm::Rest::Job",
    description: "Slurm job submission request (POST /slurm/v0.0.39/job/submit)",
    properties: {
      name: {
        type: "string",
        description: "Job name",
        required: false,
      },
      account: {
        type: "string",
        description: "Charge resources used to this account",
        required: false,
      },
      partition: {
        type: "string",
        description: "Partition to submit the job to",
        required: false,
      },
      node_count: {
        type: "integer",
        format: "int32",
        description: "Number of nodes to allocate",
        required: false,
      },
      task_count: {
        type: "integer",
        format: "int32",
        description: "Total number of tasks (MPI ranks)",
        required: false,
      },
      cpus_per_task: {
        type: "integer",
        format: "int32",
        description: "CPUs required per task",
        required: false,
      },
      time_limit: {
        type: "integer",
        format: "int32",
        description: "Time limit in minutes (0 = unlimited, use partition default)",
        required: false,
      },
      current_working_directory: {
        type: "string",
        description: "Working directory for the job",
        required: false,
      },
      environment: {
        type: "object",
        description: "Environment variables as key-value pairs",
        required: false,
      },
      standard_output: {
        type: "string",
        description: "Path for job stdout (supports %j for job ID)",
        required: false,
      },
      standard_error: {
        type: "string",
        description: "Path for job stderr (supports %j for job ID)",
        required: false,
      },
      memory_per_node: {
        type: "integer",
        format: "int64",
        description: "Memory required per node in megabytes",
        required: false,
      },
      memory_per_cpu: {
        type: "integer",
        format: "int64",
        description: "Memory required per CPU in megabytes",
        required: false,
      },
      gres_per_node: {
        type: "string",
        description: "Generic resource (GRES) required per node (e.g. gpu:a100:8)",
        required: false,
      },
      exclusive: {
        type: "boolean",
        description: "Allocate nodes exclusively (no sharing with other jobs)",
        required: false,
      },
      nodes: {
        type: "string",
        description: "Specific nodes to use (node list expression)",
        required: false,
      },
      constraints: {
        type: "string",
        description: "Node feature constraints (e.g. efa,gpu)",
        required: false,
      },
      script: {
        type: "string",
        description: "Batch job script content (must start with #!/...)",
        required: false,
      },
      qos: {
        type: "string",
        description: "Quality of Service name",
        required: false,
      },
      priority: {
        type: "integer",
        format: "int32",
        description: "Job priority override (0–65534; 0 = hold)",
        required: false,
      },
      licenses: {
        type: "string",
        description: "License requirements (e.g. vcs_sim:4,calibre:2)",
        required: false,
      },
      array: {
        type: "string",
        description: "Job array specification (e.g. 1-10%4 — indices with max concurrent)",
        required: false,
      },
      mail_user: {
        type: "string",
        description: "Email address(es) for job notifications",
        required: false,
      },
      comment: {
        type: "string",
        description: "Arbitrary comment attached to the job",
        required: false,
      },
    },
  },
  {
    typeName: "Slurm::Rest::Reservation",
    description: "Slurm reservation (POST /slurm/v0.0.39/reservation)",
    properties: {
      name: {
        type: "string",
        description: "Reservation name (must be unique)",
        required: true,
      },
      start_time: {
        type: "string",
        description: "Start time (ISO 8601 or SLURM_TIME_EPOCH or 'now')",
        required: false,
      },
      end_time: {
        type: "string",
        description: "End time (ISO 8601, 'now+Nd', etc.)",
        required: false,
      },
      duration: {
        type: "integer",
        format: "int32",
        description: "Duration in minutes (alternative to end_time)",
        required: false,
      },
      node_count: {
        type: "integer",
        format: "int32",
        description: "Number of nodes to reserve",
        required: false,
      },
      node_list: {
        type: "string",
        description: "Specific node list expression to reserve",
        required: false,
      },
      accounts: {
        type: "string",
        description: "Comma-separated accounts allowed to use the reservation",
        required: false,
      },
      users: {
        type: "string",
        description: "Comma-separated users allowed to use the reservation",
        required: false,
      },
      flags: {
        type: "string",
        description: "Reservation flags (e.g. MAINTENANCE,FLEX)",
        required: false,
      },
      partition: {
        type: "string",
        description: "Partition the reservation is limited to",
        required: false,
      },
    },
  },
  {
    typeName: "Slurm::Rest::QoS",
    description: "Slurm Quality of Service definition (slurmdbd QoS management)",
    properties: {
      name: {
        type: "string",
        description: "QoS name (unique identifier)",
        required: true,
      },
      priority: {
        type: "integer",
        format: "int32",
        description: "QoS priority (higher → higher scheduling priority)",
        required: false,
      },
      preempt_mode: {
        type: "string",
        description:
          "Preemption mode: CANCEL, CHECKPOINT, GANG, REQUEUE, SUSPEND, or OFF",
        required: false,
      },
      max_wall_clock_per_job: {
        type: "integer",
        format: "int32",
        description: "Maximum wall clock time per job in seconds",
        required: false,
      },
      max_cpus_per_user: {
        type: "integer",
        format: "int32",
        description: "Maximum CPUs a single user can allocate under this QoS",
        required: false,
      },
      max_nodes_per_user: {
        type: "integer",
        format: "int32",
        description: "Maximum nodes a single user can allocate under this QoS",
        required: false,
      },
      grp_cpus: {
        type: "integer",
        format: "int32",
        description: "Maximum total CPUs for all jobs in this QoS simultaneously",
        required: false,
      },
      grp_nodes: {
        type: "integer",
        format: "int32",
        description: "Maximum total nodes for all jobs in this QoS simultaneously",
        required: false,
      },
      description: {
        type: "string",
        description: "Human-readable description of this QoS",
        required: false,
      },
    },
  },
];
