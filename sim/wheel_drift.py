"""How far does a DCA wheel drift from its target mix?

Pure-random: slices fixed at the target weights.
Gap-weighted: slices sized by how underweight each leg would be after this deposit.
Each spin sends the whole deposit to one leg. Run: python3 sim/wheel_drift.py
"""
import random
import statistics as st

TARGET = {"stocks": 0.40, "crypto": 0.25, "rwa": 0.35}
DEPOSIT = 100
TRIALS = 4000


def spin(probs):
    r, acc = random.random(), 0.0
    for leg, p in probs.items():
        acc += p
        if r <= acc:
            return leg
    return leg


def worst_leg_drift(mode, weeks):
    holdings = {k: 0.0 for k in TARGET}
    for _ in range(weeks):
        total = sum(holdings.values()) + DEPOSIT
        if mode == "random":
            probs = TARGET
        else:
            gaps = {k: max(0.0, TARGET[k] * total - holdings[k]) for k in TARGET}
            s = sum(gaps.values())
            probs = {k: g / s for k, g in gaps.items()}
        holdings[spin(probs)] += DEPOSIT
    total = sum(holdings.values())
    return max(abs(holdings[k] / total - TARGET[k]) for k in TARGET)


if __name__ == "__main__":
    random.seed(7)
    for weeks in (4, 12, 26, 52):
        row = []
        for mode in ("random", "gap"):
            d = sorted(worst_leg_drift(mode, weeks) for _ in range(TRIALS))
            row.append(f"{st.mean(d) * 100:4.1f}pp (p95 {d[int(0.95 * TRIALS)] * 100:4.1f})")
        print(f"{weeks:>2} spins | pure-random {row[0]} | gap-weighted {row[1]}")
