// The single-cycle CPU with the vector unit (lib/vector.ts) through the verification suite: every scalar riscv-test
// it can run, and 32 random programs with vector units (the gate subset) ending in the golden model's state.
import { verifyCpus } from './verify/suite';

verifyCpus(['sc-v']);
