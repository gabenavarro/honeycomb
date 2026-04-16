---
name: ml-cuda-workflow
description: PyTorch, PyTorch Lightning, and HuggingFace training patterns optimized for RTX 6000 Pro Blackwell with CUDA 13.2. Covers training pipelines, fine-tuning, experiment tracking, and GPU debugging.
---

# ML/CUDA Workflow

Patterns for machine learning development on the RTX 6000 Pro (Blackwell) with CUDA 13.2.

## When to Use This Skill

- Building or modifying PyTorch / Lightning training pipelines
- Fine-tuning HuggingFace models (full, LoRA, QLoRA)
- Debugging CUDA errors or GPU memory issues
- Setting up experiment tracking (W&B, TensorBoard)
- Optimizing training performance for Blackwell architecture

## PyTorch Lightning Patterns

### LightningModule Structure
```python
class MyModel(L.LightningModule):
    def __init__(self, config):
        super().__init__()
        self.save_hyperparameters()
        self.model = ...  # Define architecture

    def forward(self, x):
        return self.model(x)

    def training_step(self, batch, batch_idx):
        loss = self._shared_step(batch)
        self.log("train/loss", loss, prog_bar=True)
        return loss

    def validation_step(self, batch, batch_idx):
        loss = self._shared_step(batch)
        self.log("val/loss", loss, prog_bar=True)

    def configure_optimizers(self):
        return torch.optim.AdamW(self.parameters(), lr=self.hparams.config.lr)
```

### Trainer Configuration for RTX 6000 Pro
```python
trainer = L.Trainer(
    accelerator="gpu",
    devices=1,  # Single RTX 6000 Pro
    precision="16-mixed",  # bf16 preferred on Blackwell
    max_epochs=100,
    callbacks=[
        L.callbacks.ModelCheckpoint(monitor="val/loss", mode="min", save_top_k=3),
        L.callbacks.EarlyStopping(monitor="val/loss", patience=10),
        L.callbacks.LearningRateMonitor(),
    ],
    logger=WandbLogger(project="my-project"),
    gradient_clip_val=1.0,
    accumulate_grad_batches=4,  # Effective batch size multiplier
)
```

## HuggingFace Fine-Tuning

### LoRA with PEFT
```python
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

model = AutoModelForCausalLM.from_pretrained("model-name", torch_dtype=torch.bfloat16)
lora_config = LoraConfig(r=16, lora_alpha=32, target_modules=["q_proj", "v_proj"], lora_dropout=0.05)
model = get_peft_model(model, lora_config)
```

### Trainer API
```python
from transformers import TrainingArguments, Trainer

args = TrainingArguments(
    output_dir="./output",
    per_device_train_batch_size=4,
    gradient_accumulation_steps=8,
    learning_rate=2e-4,
    bf16=True,  # Blackwell supports bf16 natively
    num_train_epochs=3,
    logging_steps=10,
    save_strategy="epoch",
    report_to="wandb",
)
```

## GPU / CUDA Guidelines

### RTX 6000 Pro Blackwell Specifics
- **VRAM**: Check with `torch.cuda.get_device_properties(0).total_mem`
- **Precision**: Use `bf16` (bfloat16) — native support on Blackwell, better numerical stability than fp16
- **CUDA arch**: Set `TORCH_CUDA_ARCH_LIST=Blackwell` for optimized kernels
- **Shared memory**: Container uses `--shm-size=16g` for DataLoader multiprocessing

### Memory Management
```python
# Check GPU memory
print(torch.cuda.memory_summary())

# Gradient checkpointing for large models
model.gradient_checkpointing_enable()

# Empty cache between experiments
torch.cuda.empty_cache()

# Monitor in training loop
self.log("gpu/memory_allocated_gb", torch.cuda.memory_allocated() / 1e9)
```

### Common CUDA Debugging
- **OOM**: Reduce batch size, enable gradient checkpointing, use mixed precision
- **CUDA device mismatch**: Ensure all tensors on same device — use `self.device` in LightningModule
- **NCCL errors**: Not applicable (single GPU) — if seen, check for stale processes
- **Slow training**: Check DataLoader `num_workers` (try 4-8), enable `pin_memory=True`

## Experiment Tracking

### W&B Setup
```python
import wandb
wandb.init(project="my-project", config=config_dict)
# Lightning integration:
from lightning.pytorch.loggers import WandbLogger
logger = WandbLogger(project="my-project")
```

### TensorBoard Fallback
```bash
tensorboard --logdir=lightning_logs/ --port=6006
# Port 6006 is forwarded in the devcontainer
```

## Best Practices

- Always use `lightning.seed_everything(42)` for reproducibility
- Save configs alongside checkpoints so experiments are reproducible
- Use `bf16` precision by default on Blackwell — only use fp32 for debugging
- Profile before optimizing: `torch.profiler` or Lightning's built-in profiler
- Keep data loading off the GPU: preprocess on CPU, transfer batches to GPU
- Use `safetensors` format for checkpoint saving (faster, safer than pickle)
