// riscv-tests and random programs on the multicycle and dual-core CPUs (tests/verify/suite.ts).
import { verifyCpus } from './verify/suite';

verifyCpus(['mc-fsm', 'mc-micro', 'dual']);
