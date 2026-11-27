package com.smoa.account.persistence;

import java.util.function.Supplier;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.smoa.account.UnitOfWork;

/** local/prod: 하나의 DB 트랜잭션으로 실행한다. */
@Component
@Profile({"local", "prod"})
public class MyBatisUnitOfWork implements UnitOfWork {

    private final TransactionTemplate template;

    public MyBatisUnitOfWork(PlatformTransactionManager transactionManager) {
        this.template = new TransactionTemplate(transactionManager);
    }

    @Override
    public <T> T execute(Supplier<T> work) {
        return template.execute(status -> work.get());
    }
}
