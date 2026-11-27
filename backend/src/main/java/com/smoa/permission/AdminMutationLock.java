package com.smoa.permission;

import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

import org.springframework.stereotype.Component;

import com.smoa.account.AccountRepository;
import com.smoa.account.UnitOfWork;

/**
 * 계정·패키지 관리 변경을 직렬화한다(마지막 총관리자 보호 같은 검사-후-변경 경쟁 방지).
 * JVM 락은 같은 프로세스 안의 경합을 줄이는 용도일 뿐이며, 정합성은 DB 트랜잭션 + 총관리자 패키지 행 잠금으로 보장한다.
 */
@Component
public class AdminMutationLock {

    private final ReentrantLock lock = new ReentrantLock();
    private final UnitOfWork unitOfWork;
    private final AccountRepository accounts;

    public AdminMutationLock(UnitOfWork unitOfWork, AccountRepository accounts) {
        this.unitOfWork = unitOfWork;
        this.accounts = accounts;
    }

    public <T> T run(Supplier<T> work) {
        lock.lock();
        try {
            // DB 모드: 트랜잭션 첫 문장으로 총관리자 패키지 행을 잠가 JVM 이 여러 개여도 변경이 직렬화된다.
            return unitOfWork.execute(() -> {
                accounts.lockAdminMutation();
                return work.get();
            });
        } finally {
            lock.unlock();
        }
    }
}
