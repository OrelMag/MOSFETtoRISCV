// The official riscv-tests on the multicycle and pipelined CPUs (tests/verify/suite.ts).
import { riscvTests } from './verify/suite';

riscvTests(['mc-fsm', 'mc-micro', 'pipe', 'pipe-ks', 'pipe-bal', 'pipe-bp', 'pipe-bal-bp', 'pipe-wb2', 'pipe-wt-bal-bp']);
