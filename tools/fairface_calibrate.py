"""
FairFace calibration for This African Does Not Exist.

What FairFace can (and can't) do here
-------------------------------------
FairFace (Karkkainen & Joo, 2021; CC BY 4.0) is ~108k face crops labelled with
race (7 groups, incl. "Black" and "Middle Eastern"), gender, and age bins.
It has no country/region labels, so it can't tell Lagos from Addis Ababa.

We use it for two honest things:
  1. Calibrate the age and gender mix of generated faces against real photographed
     faces labelled "Black" (and "Middle Eastern" for the North Africa profile),
     so the site doesn't drift into "everyone is 25".
  2. Print a realism checklist (age-bin balance) you can compare with /api/stats.

We deliberately do NOT feed FairFace photos into the image models as references:
that would copy real people's faces into "people who don't exist".

Usage
-----
  pip install kagglehub pandas
  python tools/fairface_calibrate.py            # writes data/fairface_calibration.json
  python tools/fairface_calibrate.py --hf       # use the Hugging Face copy instead of Kaggle

Then restart the server. FAIRFACE_BLEND in .env (0..1, default 0.5) controls how much
the calibration overrides the weights in phenotypes.json.
"""
import argparse
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "fairface_calibration.json")

# FairFace age bins -> our cohorts (only adults are generated; 15-19 bin is split)
AGE_BINS = ["0-2", "3-9", "10-19", "20-29", "30-39", "40-49", "50-59", "60-69", "more than 70"]
COHORT_SHARE = {
    "10-19": {"young_adult_18_29": 0.2},          # roughly 18-19 of the 10-19 bin
    "20-29": {"young_adult_18_29": 1.0},
    "30-39": {"adult_30_49": 1.0},
    "40-49": {"adult_30_49": 1.0},
    "50-59": {"mature_50_75": 1.0},
    "60-69": {"mature_50_75": 1.0},
    "more than 70": {"mature_50_75": 0.5},        # we cap ages at 75
}


def load_labels_kaggle():
    """Load the label CSVs only (no images) from the Kaggle copy."""
    import kagglehub
    import pandas as pd

    path = kagglehub.dataset_download("aibloy/fairface")
    frames = []
    for csv in glob.glob(os.path.join(path, "**", "*.csv"), recursive=True):
        df = pd.read_csv(csv)
        cols = {c.lower(): c for c in df.columns}
        if {"age", "gender", "race"} <= set(cols):
            frames.append(df.rename(columns={cols["age"]: "age", cols["gender"]: "gender", cols["race"]: "race"})[["age", "gender", "race"]])
    if frames:
        return pd.concat(frames, ignore_index=True)

    # Some Kaggle mirrors ship parquet in Hugging Face layout instead of CSV
    for pq in glob.glob(os.path.join(path, "**", "*.parquet"), recursive=True):
        df = pd.read_parquet(pq, columns=None)
        keep = [c for c in df.columns if c.lower() in ("age", "gender", "race")]
        if len(keep) == 3:
            frames.append(df[keep].rename(columns=str.lower))
    if frames:
        return decode_hf_ints(pd.concat(frames, ignore_index=True))
    raise RuntimeError(f"No label files with age/gender/race found under {path}")


def decode_hf_ints(df):
    """The HF FairFace stores labels as ClassLabel ints. Map them to strings."""
    if df["age"].dtype.kind in "iu":
        df["age"] = df["age"].map(dict(enumerate(AGE_BINS)))
    if df["gender"].dtype.kind in "iu":
        df["gender"] = df["gender"].map({0: "Male", 1: "Female"})
    if df["race"].dtype.kind in "iu":
        races = ["East Asian", "Indian", "Black", "White", "Middle Eastern", "Latino_Hispanic", "Southeast Asian"]
        df["race"] = df["race"].map(dict(enumerate(races)))
    return df


def load_labels_hf():
    from datasets import load_dataset
    ds = load_dataset("HuggingFaceM4/FairFace", "1.25", split="train")
    ds = ds.remove_columns([c for c in ds.column_names if c not in ("age", "gender", "race")])
    feats = ds.features
    df = ds.to_pandas()
    for col in ("age", "gender", "race"):
        names = getattr(feats[col], "names", None)
        if names:
            df[col] = df[col].map(dict(enumerate(names)))
    return df


def cohort_weights(df):
    totals = {"young_adult_18_29": 0.0, "adult_30_49": 0.0, "mature_50_75": 0.0}
    for bin_name, n in df["age"].value_counts().items():
        for cohort, share in COHORT_SHARE.get(str(bin_name), {}).items():
            totals[cohort] += n * share
    s = sum(totals.values()) or 1
    return {k: round(v / s, 4) for k, v in totals.items()}


def gender_weights(df):
    g = df["gender"].str.lower().value_counts(normalize=True)
    return {"woman": round(float(g.get("female", 0.5)), 4), "man": round(float(g.get("male", 0.5)), 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hf", action="store_true", help="load from Hugging Face (needs `pip install datasets`)")
    args = ap.parse_args()

    df = load_labels_hf() if args.hf else load_labels_kaggle()
    df["race"] = df["race"].astype(str)
    print(f"Loaded {len(df):,} FairFace labels")

    black = df[df["race"].str.lower() == "black"]
    mideast = df[df["race"].str.lower().str.contains("middle")]
    if black.empty:
        sys.exit("No 'Black' rows found — check the race column values: " + str(df["race"].unique()[:10]))

    result = {
        "source": "FairFace (Karkkainen & Joo 2021), labels only",
        "rows_black": int(len(black)),
        "rows_middle_eastern": int(len(mideast)),
        # used by server.js
        "age_cohort_weights": cohort_weights(black),
        "gender_weights": gender_weights(black),
        # for reference / your own tuning
        "north_africa_reference": {
            "age_cohort_weights": cohort_weights(mideast) if len(mideast) else None,
            "gender_weights": gender_weights(mideast) if len(mideast) else None,
        },
        "age_bin_distribution_black": {k: round(float(v), 4) for k, v in black["age"].value_counts(normalize=True).items()},
        "note": "FairFace comes from Flickr photos, so it reflects who gets photographed online, "
                "not population census data. Blend it, don't copy it (FAIRFACE_BLEND).",
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))
    print(f"\nWrote {OUT}. Restart the server to apply.")


if __name__ == "__main__":
    main()
