// The layers in the order they are compiled. Chapter codes adds TCP after UDP.

import { ARP } from './arp';
import { ETH } from './eth';
import { ICMP } from './icmp';
import { IP } from './ip';
import type { StackModule } from './index';
import { UDP } from './udp';

export const DEFAULT_STACK: readonly StackModule[] = [ETH, ARP, IP, ICMP, UDP];
export { ARP, ETH, ICMP, IP, UDP };
