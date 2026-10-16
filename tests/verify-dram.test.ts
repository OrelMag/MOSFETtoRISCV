// riscv-tests and random programs on the CPUs whose main memory is chapter 33's DRAM (tests/verify/suite.ts).
import { verifyCpus } from './verify/suite';

verifyCpus(['sc-wb2-dram', 'sc-wb2-dramc', 'pipe-wb2-dram']);
