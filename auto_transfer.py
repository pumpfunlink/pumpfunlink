"""
Auto Transfer Module for Solana Wallet Monitor Bot
Contains all auto-transfer related functionality
"""

import os
import logging
import asyncio
import json
import base58
from datetime import datetime
import aiohttp

# Make TRANSFER_RPC_URL accessible to main.py
TRANSFER_RPC_URL = (
    os.getenv("TRANSFER_RPC_URL") or os.getenv("RPC_URL")
)  # Use TRANSFER_RPC_URL as fallback

logger = logging.getLogger(__name__)

# Auto-transfer configuration
MIN_AUTO_TRANSFER_AMOUNT = 0.0002  # SOL - الحد الأدنى للتحويل التلقائي
RECIPIENT_ADDRESS = (
    "FUMnrwov6NuztUmmZZP97587aDZEH4WuKn8bgG6UqjXG"  # عنوان المستلم الافتراضي
)
# تحسينات التحويل السريع مع RPC المخصص
FAST_TRANSFER_CONFIG = {
    "max_requests_per_second": 25,  # السعة القصوى لـ TRANSFER_RPC_URL
    "timeout": 5,  # timeout أقصر للاستجابة السريعة
    "max_retries": 2,  # محاولات أقل للسرعة
    "commitment": "confirmed",  # commitment أسرع من finalized
    "skip_preflight": False,  # للأمان مع الحفاظ على السرعة
    "preflight_commitment": "processed",  # أسرع preflight
}

def format_sol_amount(lamports: int) -> str:
    """Convert lamports to SOL"""
    sol = lamports / 1_000_000_000  # 1 SOL = 1 billion lamports
    return f"{sol:.9f}"

def format_timestamp(timestamp: int) -> str:
    """Format Unix timestamp to readable string"""
    if not timestamp:
        return "غير محدد"
    dt = datetime.fromtimestamp(timestamp)
    return dt.strftime("%Y-%m-%d %H:%M:%S")

def truncate_address(address: str, length: int = 8) -> str:
    """Truncate wallet address for display"""
    if len(address) <= length * 2:
        return address
    return f"{address[:length]}...{address[-length:]}"

class AutoTransfer:
    def __init__(self, session: aiohttp.ClientSession = None, make_rpc_call=None, get_wallet_balance=None, get_blockchain_time=None):
        self.session = session
        self.make_rpc_call = make_rpc_call
        self.get_wallet_balance = get_wallet_balance
        self.get_blockchain_time = get_blockchain_time

        # تسجيل تفصيلي للتحويلات
        self.detailed_logger = logging.getLogger("detailed_transfers")
        
        # 🔥 Blockhash caching system for ultra-fast transfers
        self.cached_blockhash = None
        self.cached_blockhash_time = 0
        self.blockhash_cache_duration = 15  # 15 seconds cache duration (safe)
        self.blockhash_lock = asyncio.Lock()  # Thread-safe cache access
        
        # Performance tracking
        self.cache_hits = 0
        self.cache_misses = 0
        self.parallel_transfers_count = 0

    def set_min_auto_transfer_amount(self, amount: float):
        """Set minimum auto-transfer amount"""
        global MIN_AUTO_TRANSFER_AMOUNT
        MIN_AUTO_TRANSFER_AMOUNT = amount

    def get_min_auto_transfer_amount(self) -> float:
        """Get minimum auto-transfer amount"""
        return MIN_AUTO_TRANSFER_AMOUNT

    def set_recipient_address(self, address: str):
        """Set recipient address for auto-transfers"""
        global RECIPIENT_ADDRESS
        RECIPIENT_ADDRESS = address

    def get_recipient_address(self) -> str:
        """Get current recipient address"""
        return RECIPIENT_ADDRESS

    async def get_cached_blockhash(self) -> tuple[str, bool]:
        """Get cached blockhash or fetch new one - returns (blockhash, was_cached)"""
        async with self.blockhash_lock:
            current_time = asyncio.get_event_loop().time()
            
            # Check if cached blockhash is still valid (within 15 seconds)
            if (self.cached_blockhash and 
                current_time - self.cached_blockhash_time < self.blockhash_cache_duration):
                
                self.cache_hits += 1
                logger.debug(f"🎯 Using cached blockhash (age: {current_time - self.cached_blockhash_time:.1f}s)")
                return self.cached_blockhash, True
            
            # Cache expired or not available, fetch new blockhash
            return await self._fetch_fresh_blockhash()

    async def _fetch_fresh_blockhash(self) -> tuple[str, bool]:
        """Fetch fresh blockhash and cache it"""
        try:
            blockhash_payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getLatestBlockhash",
                "params": [{"commitment": "processed"}],  # أسرع commitment
            }

            response = await self.make_rpc_call(blockhash_payload, max_retries=1)
            if response and "result" in response:
                fresh_blockhash = response["result"]["value"]["blockhash"]
                
                # Cache the new blockhash
                self.cached_blockhash = fresh_blockhash
                self.cached_blockhash_time = asyncio.get_event_loop().time()
                self.cache_misses += 1
                
                logger.debug(f"🆕 Fetched and cached fresh blockhash: {fresh_blockhash[:8]}...")
                return fresh_blockhash, False
            else:
                raise Exception("Failed to get blockhash from RPC")
                
        except Exception as e:
            logger.error(f"❌ Error fetching fresh blockhash: {e}")
            # If we have an old cached blockhash, use it as emergency fallback
            if self.cached_blockhash:
                logger.warning("⚠️ Using old cached blockhash as emergency fallback")
                return self.cached_blockhash, True
            raise

    async def invalidate_blockhash_cache(self):
        """Force invalidate cached blockhash for immediate refresh"""
        async with self.blockhash_lock:
            self.cached_blockhash = None
            self.cached_blockhash_time = 0
            logger.debug("🗑️ Blockhash cache invalidated")

    async def send_parallel_transfers(self, transfer_requests: list) -> list:
        """Send multiple transfers in parallel using same blockhash"""
        try:
            if not transfer_requests:
                return []

            logger.info(f"🚀 Starting parallel transfer batch: {len(transfer_requests)} transfers")
            
            # Get single blockhash for all transfers
            shared_blockhash, was_cached = await self.get_cached_blockhash()
            
            if was_cached:
                logger.info(f"⚡ Using cached blockhash for {len(transfer_requests)} parallel transfers")
            else:
                logger.info(f"🆕 Using fresh blockhash for {len(transfer_requests)} parallel transfers")
            
            # Create all transfer tasks with shared blockhash
            transfer_tasks = []
            for req in transfer_requests:
                task = asyncio.create_task(
                    self._execute_transfer_with_blockhash(
                        req["from_wallet"],
                        req["private_key"], 
                        req["to_wallet"],
                        shared_blockhash,
                        req.get("use_priority_fee", True)
                    )
                )
                transfer_tasks.append(task)
            
            # Execute all transfers in parallel
            results = await asyncio.gather(*transfer_tasks, return_exceptions=True)
            
            self.parallel_transfers_count += len(transfer_requests)
            logger.info(f"🎯 Completed parallel transfer batch: {len(results)} results")
            
            return results
            
        except Exception as e:
            logger.error(f"❌ Error in parallel transfers: {e}")
            return []

    async def get_optimal_priority_fee(self) -> int:
        """Get optimal priority fee ensuring total fees don't exceed 0.000055 SOL"""
        try:
            # رسوم الشبكة الأساسية الثابتة
            BASE_NETWORK_FEE_SOL = 0.000005  # رسوم الشبكة الأساسية

            # الحد الأقصى المسموح به للرسوم الكاملة
            MAX_TOTAL_FEES_SOL = 0.000055

            # الحد الأدنى لرسوم الأولوية (لضمان سرعة معقولة)
            MIN_PRIORITY_FEE_SOL = 0.000010

            # احسب الحد الأقصى المتاح لرسوم الأولوية
            MAX_PRIORITY_FEE_SOL = (
                MAX_TOTAL_FEES_SOL - BASE_NETWORK_FEE_SOL
            )  # 0.000050 SOL

            COMPUTE_UNITS = 200000
            MAX_PRIORITY_FEE_MICRO_LAMPORTS = int(
                (MAX_PRIORITY_FEE_SOL * 1_000_000_000) / COMPUTE_UNITS * 1_000_000
            )
            MIN_PRIORITY_FEE_MICRO_LAMPORTS = int(
                (MIN_PRIORITY_FEE_SOL * 1_000_000_000) / COMPUTE_UNITS * 1_000_000
            )

            # احصل على معلومات الرسوم الحالية من الشبكة
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getRecentPrioritizationFees",
                "params": [[RECIPIENT_ADDRESS]],
            }

            data = await self.make_rpc_call(payload)
            if data and "result" in data and data["result"]:
                fees = data["result"]
                if fees:
                    # احسب متوسط الرسوم الأخيرة
                    recent_fees = [fee["prioritizationFee"] for fee in fees[-10:]]
                    if recent_fees:
                        avg_fee = sum(recent_fees) / len(recent_fees)
                        # أضف هامش أمان 20% (مخفض أكثر لضمان عدم تجاوز الحد)
                        optimal_fee = int(avg_fee * 1.2)
                        # تطبيق الحد الأدنى والأقصى الصارم
                        optimal_fee = max(
                            MIN_PRIORITY_FEE_MICRO_LAMPORTS,
                            min(optimal_fee, MAX_PRIORITY_FEE_MICRO_LAMPORTS),
                        )

                        # حساب التكلفة الفعلية لرسوم الأولوية
                        priority_cost_sol = (optimal_fee * COMPUTE_UNITS) / (
                            1_000_000 * 1_000_000_000
                        )
                        total_cost_sol = BASE_NETWORK_FEE_SOL + priority_cost_sol

                        logger.info(
                            f"💰 Priority fee: {optimal_fee} μλ/CU (≈{priority_cost_sol:.9f} SOL)"
                        )
                        logger.info(
                            f"💰 Total fees: {total_cost_sol:.9f} SOL (Base: {BASE_NETWORK_FEE_SOL:.9f} + Priority: {priority_cost_sol:.9f})"
                        )
                        logger.info(
                            f"📊 Within limit: {total_cost_sol <= MAX_TOTAL_FEES_SOL} (Max: {MAX_TOTAL_FEES_SOL:.9f} SOL)"
                        )

                        return optimal_fee

            # القيمة الافتراضية مع ضمان عدم تجاوز الحد الكامل
            default_fee = max(
                MIN_PRIORITY_FEE_MICRO_LAMPORTS,
                min(8000, MAX_PRIORITY_FEE_MICRO_LAMPORTS),
            )
            default_priority_cost = (default_fee * COMPUTE_UNITS) / (
                1_000_000 * 1_000_000_000
            )
            default_total_cost = BASE_NETWORK_FEE_SOL + default_priority_cost

            logger.info(f"💰 Default priority fee: {default_fee} μλ/CU")
            logger.info(
                f"💰 Default total fees: {default_total_cost:.9f} SOL (Base: {BASE_NETWORK_FEE_SOL:.9f} + Priority: {default_priority_cost:.9f})"
            )

            return default_fee

        except Exception as e:
            # رسوم طوارئ منخفضة جداً لضمان عدم تجاوز الحد
            BASE_NETWORK_FEE_SOL = 0.000005
            MAX_TOTAL_FEES_SOL = 0.000055
            MAX_PRIORITY_FEE_SOL = MAX_TOTAL_FEES_SOL - BASE_NETWORK_FEE_SOL
            COMPUTE_UNITS = 200000

            emergency_fee = int(
                (MAX_PRIORITY_FEE_SOL * 0.5 * 1_000_000_000) / COMPUTE_UNITS * 1_000_000
            )  # 50% من الحد الأقصى
            emergency_priority_cost = (emergency_fee * COMPUTE_UNITS) / (
                1_000_000 * 1_000_000_000
            )
            emergency_total_cost = BASE_NETWORK_FEE_SOL + emergency_priority_cost

            logger.warning(f"⚠️ Error getting priority fee, using emergency fee")
            logger.warning(
                f"💰 Emergency total fees: {emergency_total_cost:.9f} SOL (Base: {BASE_NETWORK_FEE_SOL:.9f} + Priority: {emergency_priority_cost:.9f})"
            )

            return emergency_fee

    async def check_signature_status_fast(self, signature: str) -> dict:
        """Ultra-fast signature status check using dedicated RPC"""
        try:
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getSignatureStatuses",
                "params": [[signature], {"searchTransactionHistory": True}],
            }

            # استخدام RPC المخصص مع timeout سريع
            timeout = FAST_TRANSFER_CONFIG["timeout"]
            async with self.session.post(
                TRANSFER_RPC_URL, json=payload, timeout=timeout
            ) as response:
                if response.status == 200:
                    data = await response.json()
                    if data and "result" in data and "value" in data["result"]:
                        result = data["result"]["value"][0]
                        if result is not None:
                            return {
                                "confirmed": True,
                                "status": result,
                                "slot": result.get("slot"),
                                "confirmations": result.get("confirmations"),
                                "err": result.get("err"),
                            }

            return {"confirmed": False, "status": None}

        except Exception as e:
            logger.debug(f"Fast signature status check error: {e}")
            return {"confirmed": False, "status": None}

    async def auto_transfer_funds_fast(
        self,
        from_wallet: str,
        private_key: str,
        to_wallet: str,
        use_priority_fee: bool = True,
    ) -> tuple[bool, str]:
        """🔥 CACHED BLOCKHASH auto-transfer optimized for sub-0.5s completion"""
        transfer_id = f"cached_transfer_{from_wallet[:8]}_{int(asyncio.get_event_loop().time())}"

        try:
            import base58
            from solders.keypair import Keypair
            from solders.pubkey import Pubkey
            from solders.system_program import TransferParams, transfer
            from solders.transaction import Transaction
            from solders.message import Message
            from solders.compute_budget import (
                set_compute_unit_price,
                set_compute_unit_limit,
            )
            import json

            function_start_time = asyncio.get_event_loop().time()
            logger.info(f"🔥 [{transfer_id}] Starting CACHED BLOCKHASH auto-transfer (target: <0.5s)")

            # Step 1: Quick balance check (optimized)
            current_balance = await self.get_wallet_balance(from_wallet)
            if current_balance <= 0:
                return False, None

            # Step 2: Fast fee calculation (static values for speed)
            BASE_TRANSFER_FEE = 0.000005
            priority_fee_sol = 0
            priority_fee_micro_lamports = 0

            if use_priority_fee:
                # Static high priority fee for maximum speed
                priority_fee_micro_lamports = 35000  # 0.000035 SOL
                compute_units = 200000
                priority_fee_lamports = (priority_fee_micro_lamports * compute_units) / 1_000_000
                priority_fee_sol = priority_fee_lamports / 1_000_000_000

            TOTAL_TRANSFER_FEE = BASE_TRANSFER_FEE + priority_fee_sol
            MAX_TOTAL_FEES = 0.000055

            if TOTAL_TRANSFER_FEE > MAX_TOTAL_FEES:
                priority_fee_sol = MAX_TOTAL_FEES - BASE_TRANSFER_FEE
                priority_fee_micro_lamports = int(
                    (priority_fee_sol * 1_000_000_000 / compute_units) * 1_000_000
                )
                TOTAL_TRANSFER_FEE = MAX_TOTAL_FEES

            if current_balance <= TOTAL_TRANSFER_FEE:
                return False, None

            amount_to_send = current_balance - TOTAL_TRANSFER_FEE
            transfer_lamports = int(amount_to_send * 1_000_000_000)

            if transfer_lamports <= 0:
                return False, None

            # Step 3: Create keypair (optimized)
            try:
                if private_key.startswith("[") and private_key.endswith("]"):
                    key_array = json.loads(private_key)
                    keypair = Keypair.from_bytes(bytes(key_array))
                else:
                    private_key_bytes = base58.b58decode(private_key)
                    keypair = Keypair.from_bytes(private_key_bytes)

                destination_pubkey = Pubkey.from_string(to_wallet)
                    
            except Exception as e:
                logger.error(f"❌ [{transfer_id}] Keypair creation failed: {e}")
                return False, None

            # Step 4: 🔥 USE CACHED BLOCKHASH - This is the speed breakthrough!
            blockhash_start_time = asyncio.get_event_loop().time()
            
            recent_blockhash, was_cached = await self.get_cached_blockhash()
            
            blockhash_duration = asyncio.get_event_loop().time() - blockhash_start_time
            
            if was_cached:
                logger.info(f"🎯 [{transfer_id}] CACHED blockhash used in {blockhash_duration:.4f}s - MAJOR SPEEDUP!")
            else:
                logger.info(f"🆕 [{transfer_id}] Fresh blockhash fetched in {blockhash_duration:.3f}s")

            # Step 5: Build and send transaction with cached blockhash
            try:
                instructions = []

                if use_priority_fee:
                    instructions.append(set_compute_unit_limit(200000))
                    instructions.append(set_compute_unit_price(priority_fee_micro_lamports))

                instructions.append(
                    transfer(
                        TransferParams(
                            from_pubkey=keypair.pubkey(),
                            to_pubkey=destination_pubkey,
                            lamports=transfer_lamports,
                        )
                    )
                )

                from solders.hash import Hash
                recent_blockhash_hash = Hash.from_string(recent_blockhash)

                message = Message.new_with_blockhash(
                    instructions, keypair.pubkey(), recent_blockhash_hash
                )
                transaction = Transaction([keypair], message, recent_blockhash_hash)

                import base64
                serialized_tx = base64.b64encode(bytes(transaction)).decode("utf-8")

                send_payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "sendTransaction",
                    "params": [
                        serialized_tx,
                        {
                            "encoding": "base64",
                            "maxRetries": 0,
                            "skipPreflight": True,
                            "preflightCommitment": "processed",
                        },
                    ],
                }

                # Send transaction
                send_start = asyncio.get_event_loop().time()
                
                try:
                    async with self.session.post(
                        TRANSFER_RPC_URL, json=send_payload, timeout=2
                    ) as response:
                        if response.status == 200:
                            send_response = await response.json()
                        else:
                            send_response = None
                except Exception:
                    send_response = await self.make_rpc_call(send_payload, max_retries=1)

                if not send_response or "result" not in send_response:
                    # Check if error is due to blockhash
                    if send_response and "error" in send_response:
                        error_msg = str(send_response["error"])
                        if "BlockhashNotFound" in error_msg or "blockhash" in error_msg.lower():
                            logger.warning(f"⚠️ [{transfer_id}] Blockhash expired, invalidating cache and retrying...")
                            await self.invalidate_blockhash_cache()
                            # Recursive retry with fresh blockhash
                            return await self.auto_transfer_funds_fast(
                                from_wallet, private_key, to_wallet, use_priority_fee
                            )
                    return False, None

                tx_signature = send_response["result"]
                send_duration = asyncio.get_event_loop().time() - send_start
                
                logger.info(f"⚡ [{transfer_id}] Transaction sent in {send_duration:.3f}s! Sig: {tx_signature[:16]}...")

                # Quick confirmation check (minimal)
                for check_attempt in range(1):  # Only 1 attempt for speed
                    await asyncio.sleep(0.1)  # 100ms check

                    status_result = await self.check_signature_status_fast(tx_signature)
                    if status_result["confirmed"] and status_result["status"].get("err") is None:
                        total_time = asyncio.get_event_loop().time() - function_start_time
                        logger.info(f"⚡ [{transfer_id}] CONFIRMED in {total_time:.3f}s!")
                        return True, tx_signature

                # Return optimistically for maximum speed
                total_time = asyncio.get_event_loop().time() - function_start_time
                cache_efficiency = f" (Cache hit: {was_cached})" if was_cached else " (Cache miss)"
                
                logger.info(f"🔥 [{transfer_id}] CACHED TRANSFER completed in {total_time:.3f}s{cache_efficiency}")
                logger.info(f"📊 Cache stats: Hits: {self.cache_hits}, Misses: {self.cache_misses}")
                
                return True, tx_signature

            except Exception as e:
                logger.error(f"❌ [{transfer_id}] Transaction build/send error: {e}")
                return False, None

        except Exception as e:
            logger.error(f"❌ [{transfer_id}] Critical error: {e}")
            return False, None

    async def _execute_transfer_with_blockhash(
        self,
        from_wallet: str,
        private_key: str,
        to_wallet: str,
        shared_blockhash: str,
        use_priority_fee: bool = True,
    ) -> tuple[bool, str]:
        """Execute single transfer with pre-fetched blockhash (for parallel transfers)"""
        transfer_id = f"parallel_{from_wallet[:8]}_{int(asyncio.get_event_loop().time())}"
        
        try:
            import base58
            from solders.keypair import Keypair
            from solders.pubkey import Pubkey
            from solders.system_program import TransferParams, transfer
            from solders.transaction import Transaction
            from solders.message import Message
            from solders.compute_budget import (
                set_compute_unit_price,
                set_compute_unit_limit,
            )
            import json

            # Quick balance check
            current_balance = await self.get_wallet_balance(from_wallet)
            if current_balance <= 0:
                return False, None

            # Calculate fees and amount
            BASE_TRANSFER_FEE = 0.000005
            priority_fee_micro_lamports = 35000 if use_priority_fee else 0
            compute_units = 200000
            
            if use_priority_fee:
                priority_fee_lamports = (priority_fee_micro_lamports * compute_units) / 1_000_000
                priority_fee_sol = priority_fee_lamports / 1_000_000_000
            else:
                priority_fee_sol = 0

            TOTAL_TRANSFER_FEE = BASE_TRANSFER_FEE + priority_fee_sol
            
            if current_balance <= TOTAL_TRANSFER_FEE:
                return False, None

            amount_to_send = current_balance - TOTAL_TRANSFER_FEE
            transfer_lamports = int(amount_to_send * 1_000_000_000)

            if transfer_lamports <= 0:
                return False, None

            # Create keypair
            if private_key.startswith("[") and private_key.endswith("]"):
                key_array = json.loads(private_key)
                keypair = Keypair.from_bytes(bytes(key_array))
            else:
                private_key_bytes = base58.b58decode(private_key)
                keypair = Keypair.from_bytes(private_key_bytes)

            destination_pubkey = Pubkey.from_string(to_wallet)

            # Build transaction with shared blockhash
            instructions = []

            if use_priority_fee:
                instructions.append(set_compute_unit_limit(200000))
                instructions.append(set_compute_unit_price(priority_fee_micro_lamports))

            instructions.append(
                transfer(
                    TransferParams(
                        from_pubkey=keypair.pubkey(),
                        to_pubkey=destination_pubkey,
                        lamports=transfer_lamports,
                    )
                )
            )

            from solders.hash import Hash
            shared_blockhash_hash = Hash.from_string(shared_blockhash)

            message = Message.new_with_blockhash(
                instructions, keypair.pubkey(), shared_blockhash_hash
            )
            transaction = Transaction([keypair], message, shared_blockhash_hash)

            # Send transaction
            import base64
            serialized_tx = base64.b64encode(bytes(transaction)).decode("utf-8")

            send_payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "sendTransaction",
                "params": [
                    serialized_tx,
                    {
                        "encoding": "base64",
                        "maxRetries": 0,
                        "skipPreflight": True,
                        "preflightCommitment": "processed",
                    },
                ],
            }

            async with self.session.post(
                TRANSFER_RPC_URL, json=send_payload, timeout=2
            ) as response:
                if response.status == 200:
                    send_response = await response.json()
                    if send_response and "result" in send_response:
                        tx_signature = send_response["result"]
                        logger.info(f"⚡ [{transfer_id}] Parallel transfer sent: {tx_signature[:16]}...")
                        return True, tx_signature

            return False, None

        except Exception as e:
            logger.error(f"❌ [{transfer_id}] Parallel transfer error: {e}")
            return False, None

    