---
name: compbio-workflow
description: Bioinformatics pipelines, single-cell RNA-seq analysis, protein modeling, and computational biology patterns using scanpy, BioPython, ESM, scvi-tools, and related tools.
---

# Computational Biology Workflow

Patterns for bioinformatics analysis, single-cell genomics, protein modeling, and computational biology.

## When to Use This Skill

- Building or running single-cell RNA-seq analysis pipelines
- Processing NGS data (FASTQ → BAM → VCF)
- Protein structure prediction or embedding analysis
- Metabolic modeling and pathway analysis
- Cheminformatics and molecular analysis

## Single-Cell RNA-seq Pipeline (scanpy)

### Standard Workflow
```python
import scanpy as sc

# 1. Load data
adata = sc.read_10x_h5("filtered_feature_bc_matrix.h5")
adata.var_names_make_unique()

# 2. Quality control
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)
adata.var["mt"] = adata.var_names.str.startswith("MT-")
sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], inplace=True)
adata = adata[adata.obs.pct_counts_mt < 20].copy()

# 3. Normalize and log-transform
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)

# 4. Feature selection
sc.pp.highly_variable_genes(adata, n_top_genes=2000)

# 5. Dimensionality reduction
sc.pp.pca(adata, n_comps=50)
sc.pp.neighbors(adata, n_neighbors=15, n_pcs=30)
sc.tl.umap(adata)

# 6. Clustering
sc.tl.leiden(adata, resolution=0.5)

# 7. Differential expression
sc.tl.rank_genes_groups(adata, groupby="leiden", method="wilcoxon")

# 8. Save checkpoint
adata.write("results/processed.h5ad")
```

### scvi-tools Integration
```python
import scvi

scvi.model.SCVI.setup_anndata(adata, layer="counts")
model = scvi.model.SCVI(adata, n_latent=30)
model.train(max_epochs=200)
adata.obsm["X_scVI"] = model.get_latent_representation()
sc.pp.neighbors(adata, use_rep="X_scVI")
```

### RNA Velocity (scvelo)
```python
import scvelo as scv
scv.pp.filter_and_normalize(adata, min_shared_counts=20)
scv.pp.moments(adata, n_pcs=30, n_neighbors=30)
scv.tl.velocity(adata)
scv.tl.velocity_graph(adata)
scv.pl.velocity_embedding_stream(adata, basis="umap")
```

## NGS Processing

### FASTQ → BAM → VCF Pattern
```python
import pysam

# Read BAM file
with pysam.AlignmentFile("sample.bam", "rb") as bam:
    for read in bam.fetch("chr1", 1000, 2000):
        if read.mapping_quality >= 30:
            process_read(read)

# Read VCF
with pysam.VariantFile("variants.vcf.gz") as vcf:
    for record in vcf:
        if record.qual >= 30:
            process_variant(record)
```

### Quick Database Queries (gget)
```python
import gget
gget.info(["BRCA1", "TP53"])          # Gene info from Ensembl
gget.seq("ENSG00000012048")            # Fetch sequence
gget.blast("ATCGATCG...")              # BLAST search
gget.alphafold("Q9Y6K9")              # AlphaFold structure
```

## Protein Analysis

### ESM Embeddings
```python
import esm
model, alphabet = esm.pretrained.esm2_t33_650M_UR50D()
batch_converter = alphabet.get_batch_converter()
data = [("protein1", "MKTVRQERLKSIV...")]
_, _, tokens = batch_converter(data)
with torch.no_grad():
    results = model(tokens, repr_layers=[33])
embeddings = results["representations"][33]
```

## Metabolic Modeling
```python
import cobra
model = cobra.io.read_sbml_model("e_coli_core.xml")
solution = model.optimize()
print(f"Growth rate: {solution.objective_value:.4f}")
# Gene knockout analysis
with model:
    model.genes.get_by_id("b0726").knock_out()
    ko_solution = model.optimize()
```

## Data Management

- Raw data → `data/raw/` (gitignored, never committed)
- Processed data → `data/processed/` (gitignored, regenerable)
- Metadata → `data/metadata/` (version controlled)
- Figures → `figures/` (version controlled, publication-quality)
- Checkpoints → save `.h5ad` at pipeline stages for resumability

## Best Practices

- Set random seeds: `sc.settings.seed = 42`
- Log versions at notebook start: `scanpy.logging.print_versions()`
- Save AnnData at checkpoints so analyses are resumable
- Use `.copy()` when subsetting AnnData to avoid view-related bugs
- Figures: 300 DPI minimum, SVG/PDF for publications, colorblind-friendly palettes
- Clear notebook outputs before committing (use `nbstripout`)
- Pin dependency versions for reproducibility
