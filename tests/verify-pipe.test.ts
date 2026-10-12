// riscv-tests and random programs on the pipelined CPUs (tests/verify/suite.ts).
import { verifyCpus } from './verify/suite';

verifyCpus(['pipe', 'pipe-ks', 'pipe-bal', 'pipe-bp', 'pipe-bal-bp', 'pipe-wb2', 'pipe-wt-bal-bp']);
