// riscv-tests and random programs on the pipelined RV32IM CPUs (tests/verify/suite.ts).
import { verifyCpus } from './verify/suite';

verifyCpus(['pipe-m', 'pipe-m-bal-bp']);
